import { Injectable, Logger, Inject } from '@nestjs/common'
import { Processor, InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { Job } from 'bullmq'
import Redis from 'ioredis'
import { MAX_DLQ_RETRIES } from '../../common/constants'
import { moveToDeadQueue } from './utils/dlq.util'

@Processor('danbooru-dlq', { concurrency: 3 })
@Injectable()
export class DlqConsumer {
  private readonly logger = new Logger(DlqConsumer.name)

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @InjectQueue('danbooru-requests') private readonly mainQueue: Queue,
  ) {}

  async process(
    job: Job<{
      jobId: string
      error: string
      query: string
      retryCount: number
      originalError?: string
    }>,
  ) {
    const data = job.data
    const { jobId, error, query, retryCount, originalError } = data

    this.logger.error(
      `Processing DLQ job ${jobId}: error = ${error}, query = ${query}, retry = ${retryCount}/${MAX_DLQ_RETRIES}`,
    )

    const isRetryableError =
      error.includes('No posts found') ||
      error.includes('Rate limit') ||
      error.includes('API error')

    if (isRetryableError && retryCount < MAX_DLQ_RETRIES) {
      // For retryable errors within limits, requeue with backoff
      const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 60000)
      this.logger.log(
        `Job ${jobId} backoff ${backoffDelay}ms, retry ${retryCount + 1}/${MAX_DLQ_RETRIES}`,
      )

      // Re-add to main queue with delay
      await this.mainQueue.add(
        'process-request',
        { ...data, retryCount: retryCount + 1 },
        { delay: backoffDelay, removeOnComplete: 10, removeOnFail: 5 },
      )

      this.logger.log(
        `Retried job ${jobId} to main queue (attempt ${retryCount + 1})`,
      )
      return { requeued: true }
    } else {
      // Move to dead queue for permanent failures
      await moveToDeadQueue(
        this.redis,
        'danbooru',
        jobId,
        error,
        query,
        originalError || 'Max retries exceeded',
      )
      this.logger.warn(
        `Job ${jobId} moved to dead queue (max retries or permanent error)`,
      )
      return { deadQueued: true }
    }
  }
}
