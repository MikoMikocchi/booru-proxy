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
} from '../common/constants'

@Injectable()
export class DlqConsumer implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DlqConsumer.name)
	private running = true

	constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

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

						const { jobId, error, query } = jobData

						this.logger.error(
							`Processing DLQ job ${jobId}: error = ${error}, query = ${query}`,
						)

						// Simple retry logic: if error is not permanent (e.g., 'No posts found' or 'Rate limit'), re-add to main stream
						if (
							error.includes('No posts found') ||
							error.includes('Rate limit')
						) {
							// Retry by re-adding to main stream
							await this.redis.xadd(
								REQUESTS_STREAM,
								'*',
								'jobId',
								jobId,
								'query',
								query,
							)
							this.logger.log(`Retried job ${jobId} from DLQ to main stream`)
						} else {
							this.logger.warn(
								`Permanent error for job ${jobId}, skipping retry`,
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
