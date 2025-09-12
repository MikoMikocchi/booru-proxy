import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common'
import Redis from 'ioredis'
import { REQUESTS_STREAM, DLQ_STREAM, MAX_DLQ_RETRIES } from '../constants'
import { retryFromDLQ, moveToDeadQueue } from './utils/dlq.util'

@Injectable()
export class DlqConsumer implements OnModuleInit {
  private readonly logger = new Logger(DlqConsumer.name)

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    this.logger.log('Starting DLQ stream processor')
    this.startProcessing()
  }

  async processDLQ() {
    const apiName = 'danbooru'
    const dlqStream = `${apiName}-dlq`

    try {
      // Read pending entries from DLQ stream
      const entries = await this.redis.xread(
        'BLOCK',
        5000, // Block for 5 seconds
        'STREAMS',
        dlqStream,
        '>',
        'COUNT',
        10, // Process up to 10 entries
      )

      if (!entries || !entries.length) {
        return // No new entries
      }

      const streamEntries = entries[0][1]
      for (const [streamId, fields] of streamEntries) {
        const jobId = fields.find(f => f[0] === 'jobId')?.[1]
        const error = fields.find(f => f[0] === 'error')?.[1]
        const query = fields.find(f => f[0] === 'query')?.[1]
        const retryCountStr = fields.find(f => f[0] === 'retryCount')?.[1]
        const retryCount = parseInt(retryCountStr || '0', 10)
        const originalError = fields.find(f => f[0] === 'originalError')?.[1]

        if (!jobId || !error || !query) {
          this.logger.error(`Invalid DLQ entry ${streamId}, deleting`)
          await this.redis.xdel(dlqStream, streamId)
          continue
        }

        this.logger.error(
          `Processing DLQ entry ${jobId}: error = ${error}, query = ${query}, retry = ${retryCount}/${MAX_DLQ_RETRIES}`,
        )

        const isRetryableError =
          error.includes('No posts found') ||
          error.includes('Rate limit') ||
          error.includes('API error')

        if (isRetryableError && retryCount < MAX_DLQ_RETRIES) {
          // Retry by adding back to main stream
          const newRetryCount = retryCount + 1
          this.logger.log(`Retrying job ${jobId} from DLQ to main stream (attempt ${newRetryCount})`)

          const result = await retryFromDLQ(
            this.redis,
            apiName,
            jobId,
            query,
            retryCount,
            streamId,
          )

          if (result.success) {
            this.logger.log(`Successfully retried job ${jobId}, removed from DLQ`)
          } else {
            this.logger.error(`Failed to retry job ${jobId}: ${result.error}`)
            // Leave in DLQ for manual intervention
          }
        } else {
          // Move to dead queue for permanent failures
          await moveToDeadQueue(
            this.redis,
            apiName,
            jobId,
            error,
            query,
            originalError || 'Max retries exceeded',
          )
          await this.redis.xdel(dlqStream, streamId)
          this.logger.warn(
            `Job ${jobId} moved to dead queue (max retries or permanent error)`,
          )
        }
      }
    } catch (error) {
      this.logger.error(`DLQ processing error: ${error.message}`)
    }
  }

  // Method to be called periodically or via cron/interval
  async startProcessing() {
    while (true) {
      await this.processDLQ()
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}
