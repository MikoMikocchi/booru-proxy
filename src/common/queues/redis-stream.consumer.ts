import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import Redis from 'ioredis'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateRequestDto } from '../../danbooru/dto/create-request.dto'
import { DanbooruService } from '../../danbooru/danbooru.service'
import { ValidationService } from '../../danbooru/validation.service'
import { addToDLQ, dedupCheck } from './utils/dlq.util'
import {
  DEDUP_TTL_SECONDS,
  QUERY_LOCK_TIMEOUT_SECONDS,
} from '../../common/constants'
import * as crypto from 'crypto'
import { ModuleRef } from '@nestjs/core'

@Processor('danbooru-requests', { concurrency: 5 })
@Injectable()
export class RedisStreamConsumer
  extends WorkerHost
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisStreamConsumer.name)
  private danbooruService: DanbooruService
  private validationService: ValidationService

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Inject(ModuleRef) private moduleRef: ModuleRef,
  ) {
    super()
  }

  async onModuleInit() {
    // Initialization logic if needed
  }

  async onModuleDestroy() {
    // Cleanup logic if needed
  }

  /**
   * Enhanced job processing with multi-level deduplication:
   * 1. DLQ duplicate check for recent failures
   * 2. Query-level locking to prevent concurrent processing
   * 3. Job-level deduplication as final safeguard
   */
  async process(job: Job<{ query: string; clientId?: string }>) {
    // Generate server-side jobId for uniqueness and deduplication
    const jobId = crypto.randomUUID()
    const data = job.data
    const { query, clientId } = data

    this.logger.log(
      `Processing job ${jobId} for query: ${query.replace(/./g, '*')}`,
      jobId,
    )

    // Enhanced deduplication: Check for recent duplicate queries in DLQ first
    const hasRecentDlqDuplicate = await dedupCheck(
      this.redis,
      'danbooru',
      query,
    )
    if (hasRecentDlqDuplicate) {
      this.logger.warn(
        `Recent duplicate query found in DLQ for job ${jobId}, skipping`,
        jobId,
      )
      // Note: danbooruService not yet initialized, publish directly to stream
      const responseKey = 'danbooru:responses'
      const errorResponse = JSON.stringify({
        type: 'error',
        jobId,
        error:
          'Duplicate request detected in recent failures - please try again later',
        timestamp: Date.now(),
      })
      await this.redis.xadd(
        responseKey,
        '*',
        'jobId',
        jobId,
        'data',
        errorResponse,
      )
      return { skipped: true, reason: 'DLQ duplicate' }
    }

    // Query-level locking to prevent concurrent processing of same query
    const queryHash = crypto.createHash('sha256').update(query).digest('hex')
    const lockKey = `lock:query:${queryHash}`
    const lockAcquired = await this.acquireLock(lockKey, jobId)
    if (!lockAcquired) {
      this.logger.warn(
        `Failed to acquire query lock for job ${jobId}, skipping`,
        jobId,
      )
      const responseKey = 'danbooru:responses'
      const errorResponse = JSON.stringify({
        type: 'error',
        jobId,
        error: 'Query currently being processed - please wait and try again',
        timestamp: Date.now(),
      })
      await this.redis.xadd(
        responseKey,
        '*',
        'jobId',
        jobId,
        'data',
        errorResponse,
      )
      return { skipped: true, reason: 'lock failed' }
    }

    try {
      // Get services via ModuleRef to avoid circular dependency
      if (!this.danbooruService) {
        this.danbooruService = this.moduleRef.get(DanbooruService)
      }
      if (!this.validationService) {
        this.validationService = this.moduleRef.get(ValidationService)
      }

      // Job-level deduplication as fallback
      const processedKey = `processed:${jobId}`
      const result = await this.redis.set(
        processedKey,
        '1',
        'EX',
        DEDUP_TTL_SECONDS,
        'NX',
      )
      if (result !== 'OK') {
        this.logger.warn(`Duplicate job ${jobId} detected, skipping`, jobId)
        return { skipped: true }
      }

      // Validation
      const validation = await this.validationService.validateRequest(data)
      if (!validation.valid) {
        this.logger.warn(
          `Validation failed for job ${jobId}: ${validation.error.error}`,
          jobId,
        )
        await this.danbooruService.publishResponse(jobId, validation.error)
        // Check DLQ duplicate before adding validation error
        const hasValidationDlqDuplicate = await dedupCheck(
          this.redis,
          'danbooru',
          query,
        )
        if (!hasValidationDlqDuplicate) {
          await addToDLQ(
            this.redis,
            'danbooru',
            jobId,
            validation.error.error,
            query,
          )
        } else {
          this.logger.warn(
            `Skipping DLQ entry for validation error - recent duplicate found`,
            jobId,
          )
        }
        throw new Error(`Validation failed: ${validation.error.error}`)
      }

      // Process the request
      await this.danbooruService.processRequest(jobId, query, clientId)
      return { success: true }
    } finally {
      // Always release the query lock
      await this.releaseLock(lockKey, jobId)
    }
  }

  // Helper method to acquire query lock with retry and exponential backoff
  private async acquireLock(
    lockKey: string,
    jobId: string,
    maxRetries = 3,
  ): Promise<boolean> {
    let retryCount = 0
    let delay = 100 // Start with 100ms

    while (retryCount < maxRetries) {
      const result = await this.redis.set(
        lockKey,
        jobId, // Use jobId as lock value for ownership verification
        'EX',
        QUERY_LOCK_TIMEOUT_SECONDS,
        'NX',
      )

      if (result === 'OK') {
        this.logger.debug(`Query lock acquired for ${lockKey} by job ${jobId}`)
        return true
      }

      retryCount++
      this.logger.debug(
        `Lock acquisition failed for ${lockKey}, retry ${retryCount}/${maxRetries}`,
        jobId,
      )
      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 2 // Exponential backoff
    }

    this.logger.warn(
      `Failed to acquire lock after ${maxRetries} retries for job ${jobId}`,
    )
    return false
  }

  // Helper method to release query lock (only if owned by this job)
  private async releaseLock(lockKey: string, jobId: string): Promise<void> {
    const currentLockValue = await this.redis.get(lockKey)
    if (currentLockValue === jobId) {
      await this.redis.del(lockKey)
      this.logger.debug(`Query lock released for ${lockKey} by job ${jobId}`)
    } else {
      this.logger.debug(
        `Lock ${lockKey} not owned by job ${jobId}, skipping release`,
      )
    }
  }
}
