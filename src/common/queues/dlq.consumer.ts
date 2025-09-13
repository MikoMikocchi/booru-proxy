import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common'
import Redis from 'ioredis'
import * as crypto from 'crypto'
import { getStreamName, MAX_DLQ_RETRIES } from '../constants'
import { retryFromDLQ, moveToDeadQueue } from './utils/dlq.util'

@Injectable()
export class DlqConsumer implements OnModuleInit {
  private readonly logger = new Logger(DlqConsumer.name)

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async onModuleInit() {
    this.logger.log('Starting DLQ stream processor for all APIs')
    this.startProcessing()
  }

  async processDLQ(apiPrefix: string) {
    const dlqStream = getStreamName(apiPrefix, 'dlq')

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
        const queryHash = fields.find(f => f[0] === 'query')?.[1] // Now stores hash
        const retryCountStr = fields.find(f => f[0] === 'retryCount')?.[1]
        const retryCount = parseInt(retryCountStr || '0', 10)
        const originalError = fields.find(f => f[0] === 'originalError')?.[1]

        if (!jobId || !error || !queryHash) {
          this.logger.error(
            `Invalid DLQ entry ${streamId} for ${apiPrefix}, deleting`,
          )
          await this.redis.xdel(dlqStream, streamId)
          continue
        }

        const queryLength = parseInt(
          fields.find(f => f[0] === 'queryLength')?.[1] || '0',
        )
        this.logger.error(
          `Processing DLQ entry ${jobId} (${apiPrefix}): error = ${error}, query hash = ${queryHash}, length = ${queryLength} chars, retry = ${retryCount}/${MAX_DLQ_RETRIES}`,
        )

        const isRetryableError =
          error.includes('No posts found') ||
          error.includes('Rate limit') ||
          error.includes('API error')

        if (isRetryableError && retryCount < MAX_DLQ_RETRIES) {
          // Retry by adding back to main stream
          const newRetryCount = retryCount + 1
          this.logger.log(
            `Retrying job ${jobId} from DLQ to main stream (${apiPrefix}, attempt ${newRetryCount})`,
          )

          // Note: For retry, we need the original query. Since we only have hash,
          // we'll need to reconstruct or store original query separately for retry cases
          // For now, we'll skip retry for privacy-focused implementation
          // In production, consider storing encrypted/original query for retry scenarios
          this.logger.warn(
            `Skipping retry for job ${jobId} (${apiPrefix}) - original query not available due to privacy masking`,
          )

          // Move to dead queue instead of retrying
          await moveToDeadQueue(
            this.redis,
            apiPrefix,
            jobId,
            error,
            queryHash,
            originalError ||
              `Retry skipped due to privacy masking (attempt ${newRetryCount})`,
          )
          await this.redis.xdel(dlqStream, streamId)
          continue

          // Original retry logic (commented for privacy):
          /*
          const result = await retryFromDLQ(
            this.redis,
            apiPrefix,
            jobId,
            query, // Would need original query here
            retryCount,
            streamId,
          )

          if (result.success) {
            this.logger.log(
              `Successfully retried job ${jobId}, removed from DLQ`,
            )
          } else {
            this.logger.error(`Failed to retry job ${jobId}: ${result.error}`)
            // Leave in DLQ for manual intervention
          }
          */
        } else {
          // Move to dead queue for permanent failures
          await moveToDeadQueue(
            this.redis,
            apiPrefix,
            jobId,
            error,
            queryHash,
            originalError || 'Max retries exceeded',
          )
          await this.redis.xdel(dlqStream, streamId)
          this.logger.warn(
            `Job ${jobId} moved to dead queue (${apiPrefix}, max retries or permanent error)`,
          )
        }
      }
    } catch (error) {
      this.logger.error(
        `DLQ processing error for ${apiPrefix}: ${error.message}`,
      )
    }
  }

  // Method to be called periodically or via cron/interval
  // Process DLQ for all enabled APIs
  async startProcessing() {
    while (true) {
      try {
        // Process DLQ for danbooru (and other APIs when added)
        await this.processDLQ('danbooru')
        // Add more API prefixes here as they are implemented

        // Wait before next poll cycle
        await new Promise(resolve => setTimeout(resolve, 2000))
      } catch (error) {
        this.logger.error(`Error in DLQ processing cycle: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, 5000)) // Longer wait on error
      }
    }
  }
}
