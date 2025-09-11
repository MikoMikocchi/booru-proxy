import {
	Injectable,
	Logger,
	OnModuleInit,
	OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios from 'axios'
import Redis from 'ioredis'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateRequestDto } from './dto/create-request.dto'
import {
	DanbooruResponse,
	DanbooruSuccessResponse,
	DanbooruErrorResponse,
} from './interfaces/danbooru.interface'
import { DanbooruPost } from './interfaces/danbooru-post.interface'
import {
	API_TIMEOUT_MS,
	RETRY_DELAY_MS,
	STREAM_BLOCK_MS,
} from '../common/constants'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DanbooruService.name)
	private readonly redis: Redis
	private running = true
	private lastApiCall = 0

	constructor(private configService: ConfigService) {
		const redisUrl: string =
			this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
		const url = new URL(redisUrl)
		this.redis = new Redis({
			host: url.hostname,
			port: Number(url.port) || 6379,
			username: url.username || undefined,
			password: url.password || undefined,
			tls: url.protocol === 'rediss:' ? {} : undefined,
		})
	}

	async onModuleInit() {
		this.logger.log('Starting Danbooru stream consumer')
		// Create consumer group if not exists
		try {
			await this.redis.xgroup(
				'CREATE',
				'danbooru:requests',
				'danbooru-group',
				'$',
				'MKSTREAM',
			)
			this.logger.log('Created consumer group danbooru-group')
		} catch (error) {
			if (error.message.includes('BUSYGROUP')) {
				this.logger.log('Consumer group danbooru-group already exists')
			} else {
				this.logger.error('Error creating consumer group', error)
			}
		}
		await this.startConsumer()
	}

	onModuleDestroy() {
		this.logger.log('Stopping Danbooru stream consumer')
		this.running = false
		this.redis.disconnect()
	}

	private async startConsumer() {
		while (this.running) {
			try {
				const streams = await this.redis.xreadgroup(
					'GROUP',
					'danbooru-group',
					'worker-1',
					'BLOCK',
					STREAM_BLOCK_MS,
					'STREAMS',
					'danbooru:requests',
					'>',
				)

				if (!streams) continue

				for (const stream of streams as any[]) {
					const messages = stream[1] as [string, string[]][]

					for (const message of messages) {
						const id = message[0]
						const fields = message[1]

						const jobData: { [key: string]: string } = {}
						for (let i = 0; i < fields.length; i += 2) {
							jobData[fields[i]] = fields[i + 1]
						}

						const requestDto = plainToClass(CreateRequestDto, jobData)
						const errors = await validate(requestDto)
						if (errors.length > 0) {
							this.logger.warn(
								`Validation error for job ${jobData.jobId || 'unknown'}: ${JSON.stringify(errors)}`,
							)
							await this.publishResponse(jobData.jobId || 'unknown', {
								type: 'error',
								jobId: jobData.jobId || 'unknown',
								error: 'Invalid request format',
							})
							// Add to dead-letter queue for permanent validation error
							await this.redis.xadd(
								'danbooru-dlq',
								'*',
								'jobId',
								jobData.jobId || 'unknown',
								'error',
								'Invalid request format',
								'query',
								jobData.query || '',
							)
							await this.redis.xdel('danbooru:requests', id)
							continue
						}

						const { jobId, query } = requestDto

						await this.processRequest(jobId, query)
						// ACK the message
						await this.redis.xack('danbooru:requests', 'danbooru-group', id)
						// Remove if needed, but with group, xdel not necessary if ACKed
						await this.redis.xdel('danbooru:requests', id)
					}
				}
			} catch (error) {
				if (this.running) {
					this.logger.error('Error in stream consumer', error)
					// Simple exponential backoff for transient errors
					let delay = RETRY_DELAY_MS
					for (let attempt = 0; attempt < 5; attempt++) {
						await new Promise(resolve => setTimeout(resolve, delay))
						delay = Math.min(delay * 2, 30000) // Double delay, cap at 30s
						this.logger.warn(
							`Retry attempt ${attempt + 1} after delay ${delay}ms`,
						)
					}
				}
			}
		}
	}

	async processRequest(
		jobId: string,
		query: string,
	): Promise<DanbooruResponse> {
		this.logger.log(`Processing job ${jobId} for query: ${query}`)

		try {
			// Simple rate limiting: 1 call per minute for educational purpose
			const now = Date.now()
			if (now - this.lastApiCall < 60000) {
				const errorData: DanbooruErrorResponse = {
					type: 'error',
					jobId,
					error: 'Rate limit exceeded. Try again in 1 minute.',
				}
				await this.publishResponse(jobId, errorData)
				return errorData
			}
			this.lastApiCall = now

			const login: string =
				this.configService.get<string>('DANBOORU_LOGIN') ?? ''
			const apiKey: string =
				this.configService.get<string>('DANBOORU_API_KEY') ?? ''
			if (!login || !apiKey) {
				throw new Error('DANBOORU_LOGIN and DANBOORU_API_KEY must be set')
			}
			const auth = { username: login, password: apiKey }

			const response = await axios.get<DanbooruPost[]>(
				`https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(query)}&limit=1&random=true`,
				{
					auth,
					timeout: API_TIMEOUT_MS,
				},
			)

			const posts: DanbooruPost[] = response.data
			if (posts.length === 0) {
				const errorMessage = 'No posts found for the query'
				const errorData: DanbooruErrorResponse = {
					type: 'error',
					jobId,
					error: errorMessage,
				}
				await this.publishResponse(jobId, errorData)
				// Add to dead-letter queue for permanent API error
				await this.redis.xadd(
					'danbooru-dlq',
					'*',
					'jobId',
					jobId,
					'error',
					errorMessage,
					'query',
					query,
				)
				return errorData
			}

			const post: DanbooruPost = posts[0]
			const imageUrl = post.file_url
			const author = post.tag_string_artist ?? null
			const tags = post.tag_string_general
			const rating = post.rating
			const source = post.source ?? null
			const copyright = post.tag_string_copyright

			this.logger.log(
				`Found post for job ${jobId}: author ${author}, rating ${rating}, copyright ${copyright}`,
			)

			const responseData: DanbooruSuccessResponse = {
				type: 'success',
				jobId,
				imageUrl,
				author,
				tags,
				rating,
				source,
				copyright,
			}
			await this.publishResponse(jobId, responseData)
			return responseData
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.logger.error(`Error processing job ${jobId}: ${errorMessage}`)
			const errorData: DanbooruErrorResponse = {
				type: 'error',
				jobId,
				error: errorMessage,
			}
			await this.publishResponse(jobId, errorData)
			// Add to dead-letter queue for permanent processing error
			await this.redis.xadd(
				'danbooru-dlq',
				'*',
				'jobId',
				jobId,
				'error',
				errorMessage,
				'query',
				query,
			)
			return errorData
		}
	}

	private async publishResponse(jobId: string, data: DanbooruResponse) {
		const responseKey = 'danbooru:responses'
		const message = { ...data }
		const entries = Object.entries(message).flatMap(([k, v]) => [
			k,
			v == null ? 'null' : v.toString(),
		])
		await this.redis.xadd(responseKey, '*', ...entries)
		this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
	}
}
