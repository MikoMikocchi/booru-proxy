import {
	Injectable,
	Logger,
	OnModuleInit,
	OnModuleDestroy,
	Inject,
} from '@nestjs/common'
import Redis from 'ioredis'
import {
	REQUESTS_STREAM,
	DLQ_STREAM,
	STREAM_BLOCK_MS,
	MAX_DLQ_RETRIES,
} from '../common/constants'
import { addToDLQ, moveToDeadQueue } from './utils/dlq.util'

@Injectable()
export class DlqConsumer implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DlqConsumer.name)
	private running = true

	constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {
	   this.redis.on('error', (error: Error) => {
	     this.logger.error(`Redis error in DLQ consumer: ${error.message}`, error.stack);
	   });
	 }

	async onModuleInit() {
		this.logger.log('Starting DLQ consumer')
		// Create consumer group for DLQ if not exists
		try {
			await this.redis.xgroup(
				'CREATE',
				DLQ_STREAM,
				'dlq-group',
				'$',
				'MKSTREAM',
			)
			this.logger.log('Created DLQ consumer group dlq-group')
		} catch (error) {
			if (error.message.includes('BUSYGROUP')) {
				this.logger.log('DLQ consumer group dlq-group already exists')
			} else {
				this.logger.error('Error creating DLQ consumer group', error)
			}
		}
		await this.startDlqConsumer()
	}

	onModuleDestroy() {
		this.logger.log('Stopping DLQ consumer')
		this.running = false
		this.redis.disconnect()
	}

	private async startDlqConsumer() {
		while (this.running) {
			try {
				type RedisStreamEntry = [string, [string, string[]][]]

				const streams = (await this.redis.xreadgroup(
					'GROUP',
					'dlq-group',
					'dlq-worker',
					'BLOCK',
					STREAM_BLOCK_MS,
					'STREAMS',
					DLQ_STREAM,
					'>',
				)) as RedisStreamEntry[]

				if (!streams) continue

				for (const [key, messages] of streams) {
					const messagesTyped = messages

					const promises = messagesTyped.map(async ([id, fields]) => {
						const jobData: { [key: string]: string } = {}
						for (let i = 0; i < fields.length; i += 2) {
							jobData[fields[i]] = fields[i + 1]
						}

						const { jobId, error, query, retryCount: rawRetryCount } = jobData
						const retryCount = parseInt(rawRetryCount || '0', 10)

						this.logger.error(
							`Processing DLQ job ${jobId}: error = ${error}, query = ${query}, retry = ${retryCount}/${MAX_DLQ_RETRIES}`,
						)

						const isRetryableError =
							error.includes('No posts found') ||
							error.includes('Rate limit') ||
							error.includes('API error')

						const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 60000) // 1s to 60s exponential

						if (isRetryableError && retryCount < MAX_DLQ_RETRIES) {
							// Apply backoff before retry
							this.logger.log(`Job ${jobId} backoff ${backoffDelay}ms, retry ${retryCount + 1}/${MAX_DLQ_RETRIES}`)
							await new Promise(resolve => setTimeout(resolve, backoffDelay))

							// Retry by re-adding to main stream with incremented retry count
							await addToDLQ(this.redis, jobId, error, query, retryCount + 1)
							this.logger.log(`Retried job ${jobId} from DLQ to main stream (attempt ${retryCount + 1})`)
						} else {
							// Move to dead queue
							await moveToDeadQueue(this.redis, jobId, error, query, isRetryableError ? undefined : error)
							this.logger.warn(
								`Job ${jobId} moved to dead queue (max retries or permanent error)`,
							)
						}

						// ACK the DLQ message
						await this.redis.xack(DLQ_STREAM, 'dlq-group', id)
					})

					await Promise.all(promises)
				}
			} catch (error) {
				if (this.running) {
					this.logger.error(
						'Error in DLQ consumer',
						error.stack || error.message,
					)
				}
			}
		}
	}
}
