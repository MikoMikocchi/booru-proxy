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
import { DanbooruService } from '../../danbooru/danbooru.service'
import { ValidationService } from '../../danbooru/validation.service'
import { addToDLQ, dedupCheck } from './utils/dlq.util'
import {
  DEDUP_TTL_SECONDS,
  QUERY_LOCK_TIMEOUT_SECONDS,
  getStreamName,
} from '../../common/constants'
import { LockUtil } from '../redis/utils/lock.util'
import * as crypto from 'crypto'
import { encrypt, decrypt } from '../crypto/crypto.util'
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
    private readonly lockUtil: LockUtil,
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
   * Validate incoming job message using ValidationService and DTO
   * @param data - Job data containing query, clientId, apiPrefix
   * @param apiPrefix - API prefix for validation context
   * @param jobId - Job identifier for logging
   * @returns Validation result with error if invalid
   */
  private async validateMessage(
    data: { query: string; clientId?: string; apiPrefix?: string },
    apiPrefix: string,
    jobId: string,
  ): Promise<{ valid: boolean; error?: any }> {
    try {
      // Ensure apiPrefix is set in validation config
      const validationData = { ...data, apiPrefix }
      const validation =
        await this.validationService.validateRequest(validationData)

      if (!validation.valid) {
        const queryHash = crypto
          .createHash('sha256')
          .update(data.query)
          .digest('hex')
          .slice(0, 8)
        this.logger.warn(
          `Validation failed for job ${jobId} (${apiPrefix}): ${validation.error.error} (query hash: ${queryHash})`,
          jobId,
        )
        return { valid: false, error: validation.error }
      }

      return { valid: true, error: null }
    } catch (error) {
      this.logger.error(
        `Validation service error for job ${jobId} (${apiPrefix}): ${error.message}`,
        jobId,
      )
      return {
        valid: false,
        error: {
          type: 'error',
          jobId,
          error: 'Validation service unavailable',
          code: 'VALIDATION_ERROR',
          apiPrefix,
        },
      }
    }
  }

  /**
   * Perform deduplication check using DLQ utility with apiPrefix support
   * @param apiPrefix - API prefix for stream identification
   * @param query - Query string to check for duplicates
   * @param jobId - Job identifier for cross-job deduplication
   * @returns True if duplicate found, false otherwise
   */
  private async dedupCheck(
    apiPrefix: string,
    query: string,
    jobId: string,
  ): Promise<boolean> {
    try {
      const hasDuplicate = await dedupCheck(this.redis, apiPrefix, query, jobId)
      if (hasDuplicate) {
        const queryHash = crypto
          .createHash('sha256')
          .update(query)
          .digest('hex')
          .slice(0, 8)
        this.logger.debug(
          `DLQ duplicate detected for ${apiPrefix} job ${jobId} (query hash: ${queryHash})`,
        )
      }
      return hasDuplicate
    } catch (error) {
      this.logger.error(
        `Dedup check failed for ${apiPrefix} job ${jobId}: ${error.message}`,
        jobId,
      )
      return false // Allow processing if dedup check fails to avoid blocking
    }
  }

  /**
   * Process job using appropriate API service with cache invalidation
   * @param jobId - Job identifier
   * @param query - Query string
   * @param clientId - Optional client identifier
   * @param apiPrefix - API prefix to determine service
   * @returns Promise that resolves when processing completes
   */
  private async processJob(
    jobId: string,
    query: string,
    clientId?: string,
    apiPrefix: string = 'danbooru',
  ): Promise<void> {
    try {
      // Get the appropriate service based on apiPrefix
      let apiService: any
      switch (apiPrefix.toLowerCase()) {
        case 'danbooru':
          if (!this.danbooruService) {
            this.danbooruService = this.moduleRef.get(DanbooruService, {
              strict: false,
            })
          }
          apiService = this.danbooruService
          break
        // Add more API services here as they are implemented
        default:
          const errorMsg = `Unsupported API provider: ${apiPrefix}`
          this.logger.error(errorMsg, jobId)
          throw new Error(errorMsg)
      }

      if (!apiService) {
        throw new Error(`API service not available for ${apiPrefix}`)
      }

      // Process the request using the API service
      const queryHash = crypto
        .createHash('sha256')
        .update(query)
        .digest('hex')
        .slice(0, 8)
      this.logger.debug(
        `Processing ${apiPrefix} job ${jobId} (query hash: ${queryHash})`,
      )

      await apiService.processRequest(jobId, query, clientId)

      // Invalidate related caches after successful processing (if service supports it)
      // Note: Cache invalidation should be handled by the specific API service
      this.logger.debug(
        `Cache invalidation responsibility delegated to ${apiPrefix} service for job ${jobId}`,
      )
    } catch (error) {
      const queryHash = crypto
        .createHash('sha256')
        .update(query)
        .digest('hex')
        .slice(0, 8)
      this.logger.error(
        `Job processing failed for ${apiPrefix} job ${jobId} (query hash: ${queryHash}): ${error.message}`,
        jobId,
      )
      throw error
    }
  }

  /**
   * Main job processing method - refactored to use extracted helper methods
   * Supports multiple APIs via apiPrefix parameter and getStreamName for dynamic streams
   */
  async process(
    job: Job<{ query: string; clientId?: string; apiPrefix?: string }>,
  ) {
    const jobId = crypto.randomUUID()
    const data = job.data
    const { query, clientId, apiPrefix = 'danbooru' } = data
    const queryHash = crypto
      .createHash('sha256')
      .update(query)
      .digest('hex')
      .slice(0, 8)

    this.logger.log(
      `Processing ${apiPrefix} job ${jobId} for query (${query.length} chars, hash: ${queryHash})`,
      jobId,
    )

    // 1. Query-level locking with apiPrefix prefix to prevent cross-API conflicts
    const fullQueryHash = crypto
      .createHash('sha256')
      .update(query)
      .digest('hex')
    const lockKey = `lock:query:${apiPrefix}:${fullQueryHash}`
    let lockValue: string | null = null
    let heartbeatInterval: NodeJS.Timeout | null = null

    try {
      // 2. Job-level deduplication as final safeguard
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
        return { skipped: true, reason: 'job duplicate' }
      }

      // 3. DLQ duplicate check using extracted method
      const hasDlqDuplicate = await this.dedupCheck(apiPrefix, query, jobId)
      if (hasDlqDuplicate) {
        this.logger.warn(
          `Recent duplicate query found in DLQ for ${apiPrefix} job ${jobId} (hash: ${queryHash}), skipping`,
          jobId,
        )

        const responseKey = getStreamName(apiPrefix, 'responses')
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

      // 4. Message validation using extracted method
      const validationResult = await this.validateMessage(
        data,
        apiPrefix,
        jobId,
      )
      if (!validationResult.valid) {
        // Publish validation error response
        const responseKey = getStreamName(apiPrefix, 'responses')
        await this.redis.xadd(
          responseKey,
          '*',
          'jobId',
          jobId,
          'data',
          JSON.stringify({ ...validationResult.error, timestamp: Date.now() }),
        )

        // Add to DLQ with encrypted query for privacy
        const hasValidationDlqDuplicate = await this.dedupCheck(
          apiPrefix,
          query,
          jobId,
        )
        if (!hasValidationDlqDuplicate) {
          await addToDLQ(
            this.redis,
            apiPrefix,
            jobId,
            validationResult.error.error,
            query, // plaintext - will be encrypted in addToDLQ
          )
        }

        throw new Error(`Validation failed: ${validationResult.error.error}`)
      }

      // 5. Process job using extracted method
      await this.processJob(jobId, query, clientId, apiPrefix)

      this.logger.debug(`${apiPrefix} job ${jobId} processed successfully`)
      return { success: true }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      this.logger.error(
        `${apiPrefix} job ${jobId} failed (query hash: ${queryHash}): ${errorMessage}`,
        jobId,
      )

      // For unhandled errors, add to DLQ with encrypted query
      await addToDLQ(
        this.redis,
        apiPrefix,
        jobId,
        errorMessage,
        query, // plaintext - will be encrypted in addToDLQ
      )

      // Publish error response
      const responseKey = getStreamName(apiPrefix, 'responses')
      const errorResponse = JSON.stringify({
        type: 'error',
        jobId,
        error: errorMessage,
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
      return { success: false, error: errorMessage }
    } finally {
      // Stop heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
      }

      // Always release the query lock
      if (lockValue) {
        await this.releaseLock(lockKey, lockValue)
      }
    }
  }

  // Helper method to acquire query lock with retry and exponential backoff using LockUtil
  private async acquireLock(
    lockKey: string,
    jobId: string,
    maxRetries = 3,
  ): Promise<boolean> {
    let retryCount = 0
    let delay = 100 // Start with 100ms

    while (retryCount < maxRetries) {
      const lockValue = await this.lockUtil.acquireLock(
        lockKey,
        QUERY_LOCK_TIMEOUT_SECONDS,
      )
      if (lockValue) {
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

  // Helper method to release query lock using LockUtil (only if owned by this job)
  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const released = await this.lockUtil.releaseLock(lockKey, lockValue)
    if (released) {
      this.logger.debug(`Query lock released for ${lockKey}`)
    } else {
      this.logger.debug(`Lock ${lockKey} not owned, skipping release`)
    }
  }
}
