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
	DanbooruErrorResponse,
} from './interfaces/danbooru.interface'
import { DanbooruPost } from './interfaces/danbooru-post.interface'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DanbooruService.name)
	private readonly redis: Redis
	private running = true

	constructor(private configService: ConfigService) {
		const redisUrl: string =
			this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
		const url = new URL(redisUrl)
		this.redis = new Redis({
			host: url.hostname,
			port: Number(url.port) || 6379,
			username: url.username || undefined,
			password: url.password || undefined,
		})
	}

	async onModuleInit() {
		this.logger.log('Starting Danbooru stream consumer')
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
				const streams = await this.redis.xread(
					'BLOCK',
					5000,
					'STREAMS',
					'danbooru:requests',
					'$',
				)

				if (!streams) continue

				for (const stream of streams) {
					const messages = stream[1]

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
								error: 'Invalid request format',
							})
							await this.redis.xdel('danbooru:requests', id)
							continue
						}

						const { jobId, query } = requestDto

						await this.processRequest(jobId, query)
						// Remove processed message
						await this.redis.xdel('danbooru:requests', id)
					}
				}
			} catch (error) {
				if (this.running) {
					this.logger.error('Error in stream consumer', error)
					// Wait before retry
					await new Promise(resolve => setTimeout(resolve, 5000))
				}
			}
		}
	}

	async processRequest(
		jobId: string,
		query: string,
	): Promise<DanbooruResponse | DanbooruErrorResponse> {
		this.logger.log(`Processing job ${jobId} for query: ${query}`)

		try {
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
					timeout: 10000,
				},
			)

			const posts: DanbooruPost[] = response.data
			if (posts.length === 0) {
				throw new Error('No posts found for the query')
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

			const responseData: DanbooruResponse = {
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
			const errorData: DanbooruErrorResponse = { jobId, error: errorMessage }
			await this.publishResponse(jobId, errorData)
			return errorData
		}
	}

	private async publishResponse(jobId: string, data: Record<string, any>) {
		const responseKey = 'danbooru:responses'
		const message = { jobId, ...data }
		await this.redis.xadd(responseKey, '*', ...Object.entries(message).flat())
		this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
	}
}
