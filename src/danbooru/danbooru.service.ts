import {
	Injectable,
	Logger,
	OnModuleInit,
	OnModuleDestroy,
	Inject,
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
	RATE_LIMIT_PER_MINUTE,
	RATE_WINDOW_SECONDS,
	DEDUP_TTL_SECONDS,
	MAX_RETRY_ATTEMPTS,
	MAX_BACKOFF_MS,
	REQUESTS_STREAM,
	RESPONSES_STREAM,
	DLQ_STREAM,
} from '../common/constants'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DanbooruService.name)
	private running = true

	constructor(
		private configService: ConfigService,
		@Inject('REDIS_CLIENT') private readonly redis: Redis,
	) {}

	async onModuleInit() {
		this.logger.log('Starting Danbooru stream consumer')
		// Create consumer group if not exists
		try {
			await this.redis.xgroup(
				'CREATE',
				REQUESTS_STREAM,
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
				type RedisStreamEntry = [string, [string, string[]][]]

				const streams = (await this.redis.xreadgroup(
					'GROUP',
					'danbooru-group',
					'worker-1',
					'BLOCK',
					STREAM_BLOCK_MS,
					'STREAMS',
					REQUESTS_STREAM,
					'>',
				)) as RedisStreamEntry[]

				if (!streams) continue

				for (const [key, messages] of streams) {
					const messagesTyped = messages as [string, string[]][]

					const promises = messages.map(async ([id, fields]) => {
						const jobData: { [key: string]: string } = {}
						for (let i = 0; i < fields.length; i += 2) {
							jobData[fields[i]] = fields[i + 1]
						}

						const requestDto = plainToClass(CreateRequestDto, jobData)
						const errors = await validate(requestDto)
						if (errors.length > 0) {
							this.logger.warn(
								`Validation error for job ${jobData.jobId || 'unknown'}: ${JSON.stringify(errors)}`,
								jobData.jobId || 'unknown',
							)
							await this.publishResponse(jobData.jobId || 'unknown', {
								type: 'error',
								jobId: jobData.jobId || 'unknown',
								error: 'Invalid request format',
							})
							// Add to dead-letter queue for permanent validation error
							await this.redis.xadd(
								DLQ_STREAM,
								'*',
								'jobId',
								jobData.jobId || 'unknown',
								'error',
								'Invalid request format',
								'query',
								jobData.query || '',
							)
							await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
							return
						}

						const { jobId, query } = requestDto

						// Deduplication check
						const isDuplicate = await this.redis.sismember(
							'processed_jobs',
							jobId,
						)
						if (isDuplicate) {
							this.logger.warn(
								`Duplicate job ${jobId} detected, skipping`,
								jobId,
							)
							await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
							return
						}

						// Mark as processed with TTL
						await this.redis.sadd('processed_jobs', jobId)
						await this.redis.expire('processed_jobs', DEDUP_TTL_SECONDS)

						await this.processRequest(jobId, query)
						// ACK the message
						await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
					})

					await Promise.all(promises)
				}
			} catch (error) {
				if (this.running) {
					this.logger.error(
						'Error in stream consumer',
						error.stack || error.message,
					)
					// Simple exponential backoff for transient errors
					let delay = RETRY_DELAY_MS
					for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
						await new Promise(resolve => setTimeout(resolve, delay))
						delay = Math.min(delay * 2, MAX_BACKOFF_MS) // Double delay, cap at 30s
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
		this.logger.log(`Processing job ${jobId} for query: ${query}`, jobId)

		try {
			// Check cache first
			const cached = await this.getCachedResponse(query)
			if (cached) {
				this.logger.log(`Cache hit for job ${jobId}`, jobId)
				return cached
			}

			// Distributed rate limiting: check calls per minute
			const rateLimitPerMinute =
				this.configService.get<number>('RATE_LIMIT_PER_MINUTE') ||
				RATE_LIMIT_PER_MINUTE
			const minuteKey = `rate:minute:${Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000))}`
			const currentCount = await this.redis.incr(minuteKey)
			if (currentCount === 1) {
				await this.redis.expire(minuteKey, RATE_WINDOW_SECONDS)
			}
			if (currentCount > rateLimitPerMinute) {
				const errorData: DanbooruErrorResponse = {
					type: 'error',
					jobId,
					error: 'Rate limit exceeded. Try again in 1 minute.',
				}
				await this.publishResponse(jobId, errorData)
				return errorData
			}

			const login: string =
				this.configService.get<string>('DANBOORU_LOGIN') ?? ''
			const apiKey: string =
				this.configService.get<string>('DANBOORU_API_KEY') ?? ''
			if (!login || !apiKey) {
				const errorData: DanbooruErrorResponse = {
					type: 'error',
					jobId,
					error: 'DANBOORU_LOGIN and DANBOORU_API_KEY must be set',
				}
				await this.publishResponse(jobId, errorData)
				return errorData
			}

			const limit = this.configService.get<number>('DANBOORU_LIMIT') || 1
			const random = this.configService.get<boolean>('DANBOORU_RANDOM') || true
			let url = `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(query)}&limit=${limit}&login=${encodeURIComponent(login)}&api_key=${encodeURIComponent(apiKey)}`
			if (random) {
				url += '&random=true'
			}
			const response = await axios.get<DanbooruPost[]>(url, {
				timeout: API_TIMEOUT_MS,
			})

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
					DLQ_STREAM,
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
			const tags = this.sanitizeTags(post.tag_string_general)
			const rating = post.rating
			const source = post.source ?? null
			const copyright = this.sanitizeTags(post.tag_string_copyright)

			this.logger.log(
				`Found post for job ${jobId}: author ${author}, rating ${rating}, copyright ${copyright}`,
				jobId,
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
			// Cache the response for 1h
			await this.setCache(query, responseData)
			return responseData
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.logger.error(`Error processing job ${jobId}: ${errorMessage}`, jobId)
			const errorData: DanbooruErrorResponse = {
				type: 'error',
				jobId,
				error: errorMessage,
			}
			await this.publishResponse(jobId, errorData)
			// Add to dead-letter queue for permanent processing error
			await this.redis.xadd(
				DLQ_STREAM,
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

	private sanitizeTags(tags: string): string {
		if (!tags) return tags
		// Basic sanitization to remove potential HTML/JS
		let sanitized = tags
			.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
			.replace(/<[^>]*>/g, '')
		sanitized = sanitized.replace(/&/g, '&')
		sanitized = sanitized.replace(/</g, '<')
		sanitized = sanitized.replace(/>/g, '>')
		sanitized = sanitized.replace(/"/g, '"')
		sanitized = sanitized.replace(/'/g, "'")
		return sanitized
	}
	private async publishResponse(jobId: string, data: DanbooruResponse) {
		const responseKey = RESPONSES_STREAM
		const message = { ...data }
		const entries = Object.entries(message).flatMap(([k, v]) => [
			k,
			v == null ? 'null' : v.toString(),
		])
		await this.redis.xadd(responseKey, '*', ...entries)
		this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
	}

	private async getCachedResponse(
		query: string,
	): Promise<DanbooruSuccessResponse | null> {
		const key = `cache:danbooru:${encodeURIComponent(query)}`
		const cached = await this.redis.get(key)
		if (cached) {
			return JSON.parse(cached) as DanbooruSuccessResponse
		}
		return null
	}

	private async setCache(
		query: string,
		response: DanbooruSuccessResponse,
	): Promise<void> {
		const key = `cache:danbooru:${encodeURIComponent(query)}`
		const ttl = this.configService.get<number>('CACHE_TTL_SECONDS') || 3600
		await this.redis.setex(key, ttl, JSON.stringify(response))
		this.logger.log(`Cached response for query: ${query}`)
	}
}
