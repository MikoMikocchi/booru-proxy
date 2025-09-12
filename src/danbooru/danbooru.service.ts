import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DanbooruResponse,
  DanbooruSuccessResponse,
  DanbooruErrorResponse,
} from './interfaces/danbooru.interface'
import { DanbooruPost } from './dto/danbooru-post.class'
import { addToDLQ } from '../common/queues/utils/dlq.util'
import {
  REQUESTS_STREAM,
  RESPONSES_STREAM,
  DLQ_STREAM,
  QUERY_LOCK_TIMEOUT_SECONDS,
} from '../common/constants'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import Redis from 'ioredis'
import * as crypto from 'crypto'

@Injectable()
export class DanbooruService {
  private readonly logger = new Logger(DanbooruService.name)

  constructor(
    private configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly danbooruApiService: DanbooruApiService,
    private readonly cacheService: CacheService,
    private readonly rateLimitManagerService: RateLimitManagerService,
    private readonly cacheManagerService: CacheManagerService,
  ) {}

  /**
   * Enhanced processRequest with query-level locking for deduplication
   * This method is called by the consumer after initial locking, but includes
   * additional safety locking for direct calls or future refactoring.
   */
  async processRequest(
    jobId: string,
    query: string,
    clientId?: string,
  ): Promise<DanbooruResponse> {
    this.logger.log(
      `Processing job ${jobId} for query: ${query.replace(/./g, '*')}`,
      jobId,
    )

    // Additional query-level locking for safety (uses same key as consumer)
    const queryHash = crypto.createHash('sha256').update(query).digest('hex')
    const lockKey = `lock:query:${queryHash}`

    // Try to acquire lock - if already locked by consumer, this will fail quickly
    const lockAcquired = await this.redis.set(
      lockKey,
      jobId,
      'EX',
      QUERY_LOCK_TIMEOUT_SECONDS,
      'NX',
    ) === 'OK'

    if (!lockAcquired) {
      this.logger.warn(`Additional query lock not acquired for job ${jobId} (already processing)`, jobId)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId,
        error: 'Query is currently being processed',
      }
      await this.publishResponse(jobId, error)
      return error
    }

    try {
      const random = this.configService.get<boolean>('DANBOORU_RANDOM') || true

      // Rate limiting check
      const rateCheck = await this.rateLimitManagerService.checkRateLimit(
        'danbooru',
        jobId,
        clientId,
      )
      if (!rateCheck.allowed) {
        await this.publishResponse(jobId, rateCheck.error)
        return rateCheck.error
      }

      // Cache check
      let responseOrNull: DanbooruSuccessResponse | null = null
      if (!random) {
        responseOrNull =
          await this.cacheService.getCachedResponse<DanbooruSuccessResponse>(
            'danbooru',
            query,
            random,
          )
        if (responseOrNull) {
          this.logger.log(`Cache hit for danbooru job ${jobId}`)
          await this.publishResponse(jobId, responseOrNull)
          return responseOrNull
        }
      }

      const limit = this.configService.get<number>('DANBOORU_LIMIT') || 1
      const post = await this.danbooruApiService.fetchPosts(
        query,
        limit,
        random,
      )
      if (!post) {
        const errorMessage = 'No posts found for the query or API error'
        const error: DanbooruErrorResponse = {
          type: 'error',
          jobId,
          error: errorMessage,
        }
        await this.publishResponse(jobId, error)
        await addToDLQ(this.redis, 'danbooru', jobId, errorMessage, query, 0)
        return error
      }

      const responseData = this.buildSuccessResponse(post, jobId)
      await this.publishResponse(jobId, responseData)

      // Cache the successful response
      if (!random) {
        await this.cacheService.setCache(
          'danbooru',
          query,
          responseData,
          random,
        )
      }

      return responseData
    } finally {
      // Always release the query lock if we acquired it
      const currentLockValue = await this.redis.get(lockKey)
      if (currentLockValue === jobId) {
        await this.redis.del(lockKey)
        this.logger.debug(`Service-level query lock released for ${lockKey} by job ${jobId}`)
      }
    }
  }

  async publishResponse(jobId: string, data: DanbooruResponse) {
    const responseKey = RESPONSES_STREAM
    const jsonData = JSON.stringify({ ...data, timestamp: Date.now() })

    await this.redis.xadd(responseKey, '*', 'jobId', jobId, 'data', jsonData)

    this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
  }

  private buildSuccessResponse(
    post: DanbooruPost,
    jobId: string,
  ): DanbooruSuccessResponse {
    const imageUrl = post.file_url
    const author = post.tag_string_artist ?? null
    const tags = post.tag_string_general
    const rating = post.rating
    const source = post.source ?? null
    const copyright = post.tag_string_copyright

    this.logger.log(
      `Found post for job ${jobId}: author ${author}, rating ${rating}, copyright ${copyright}`,
      jobId,
    )

    return {
      type: 'success',
      jobId,
      imageUrl,
      author,
      tags,
      rating,
      source,
      copyright,
    }
  }

  private async handleApiError(
    errorMessage: string,
    jobId: string,
    query: string,
  ): Promise<DanbooruErrorResponse> {
    const errorData: DanbooruErrorResponse = {
      type: 'error',
      jobId,
      error: errorMessage,
    }
    await this.publishResponse(jobId, errorData)
    await addToDLQ(this.redis, 'danbooru', jobId, errorMessage, query, 0)
    return errorData
  }

  private async handleProcessingError(
    error: unknown,
    jobId: string,
    query: string,
  ): Promise<DanbooruErrorResponse> {
    const errorMessage = error instanceof Error ? error.message : String(error)
    this.logger.error(`Error processing job ${jobId}: ${errorMessage}`, jobId)
    const errorData: DanbooruErrorResponse = {
      type: 'error',
      jobId,
      error: errorMessage,
    }
    await this.publishResponse(jobId, errorData)
    await addToDLQ(this.redis, 'danbooru', jobId, errorMessage, query, 0)
    return errorData
  }

  /**
   * DEDUPLICATION STRATEGY DOCUMENTATION:
   *
   * This service implements a multi-layered deduplication approach:
   *
   * 1. CONSUMER LEVEL (redis-stream.consumer.ts):
   *    - DLQ Duplicate Check: Scans recent DLQ entries for identical queries within 1 hour
   *    - Query Hash Locking: Uses Redis SET NX with 5-minute TTL to prevent concurrent processing
   *    - Server-side Job ID: Generates UUID to prevent client-side ID collisions
   *    - Job-level Deduplication: Final SET NX check as safety net
   *
   * 2. SERVICE LEVEL (this file):
   *    - Additional Query Locking: Double-checks lock acquisition for safety against direct calls
   *    - Graceful Lock Release: Ensures locks are released even on errors via try/finally
   *
   * 3. DLQ PREVENTION (dlq.util.ts):
   *    - dedupCheck(): Scans DLQ stream for recent failures before adding new entries
   *    - Time Window: Configurable 1-hour deduplication window via DLQ_DEDUP_WINDOW_SECONDS
   *
   * LOCK KEYS: `lock:query:{sha256(query)}` - 5 minutes TTL (QUERY_LOCK_TIMEOUT_SECONDS)
   * PROCESSED KEYS: `processed:{jobId}` - 24 hours TTL (DEDUP_TTL_SECONDS)
   * DLQ DEDUP WINDOW: 1 hour (DLQ_DEDUP_WINDOW_SECONDS)
   *
   * This comprehensive strategy prevents duplicate API calls to Danbooru while handling
   * race conditions, ensuring failed requests don't spam the DLQ with identical queries,
   * and providing robust protection against concurrent processing.
   */
}
