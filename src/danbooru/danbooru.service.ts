import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios from 'axios'
import Redis from 'ioredis'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DanbooruService.name)
	private readonly redis: Redis
	private running = true

	constructor(private configService: ConfigService) {
		const redisUrl =
			this.configService.get('REDIS_URL') || 'redis://localhost:6379'
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
		this.startConsumer()
	}

	async onModuleDestroy() {
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
					const streamName = stream[0]
					const messages = stream[1]

					for (const message of messages) {
						const id = message[0]
						const fields = message[1]

						const jobData: { [key: string]: string } = {}
						for (let i = 0; i < fields.length; i += 2) {
							jobData[fields[i] as string] = fields[i + 1] as string
						}

						const { jobId, query } = jobData

						if (jobId && query) {
							await this.processRequest(jobId, query)
							// Remove processed message
							await this.redis.xdel('danbooru:requests', id)
						} else {
							this.logger.warn(`Invalid message format in stream: ${id}`)
							await this.redis.xdel('danbooru:requests', id)
						}
					}
				}
			} catch (error) {
				if (this.running) {
					this.logger.error('Error in stream consumer', error)
					// Wait before retry
					await new Promise((resolve) => setTimeout(resolve, 5000))
				}
			}
		}
	}

	async processRequest(
		jobId: string,
		query: string,
	): Promise<{ imageUrl?: string; error?: string }> {
		this.logger.log(`Processing job ${jobId} for query: ${query}`)

		try {
			const login = this.configService.get('DANBOORU_LOGIN')
			const apiKey = this.configService.get('DANBOORU_API_KEY')
			const auth = { username: login, password: apiKey }

			const response = await axios.get(
				`https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(query)}&limit=1&random=true`,
				{
					auth,
					timeout: 10000,
				},
			)

			const posts = response.data
			if (posts.length === 0) {
				throw new Error('No posts found for the query')
			}

			const imageUrl = posts[0].file_url
			this.logger.log(`Found image for job ${jobId}: ${imageUrl}`)

			await this.publishResponse(jobId, { imageUrl })
			return { imageUrl }
		} catch (error) {
			this.logger.error(`Error processing job ${jobId}: ${error.message}`)
			await this.publishResponse(jobId, { error: error.message })
			return { error: error.message }
		}
	}

	private async publishResponse(
		jobId: string,
		data: { imageUrl?: string; error?: string },
	) {
		const responseKey = 'danbooru:responses'
		const message = { jobId, ...data }
		await this.redis.xadd(responseKey, '*', ...Object.entries(message).flat())
		this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
	}
}
