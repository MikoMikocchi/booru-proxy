import { Injectable, Logger, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DanbooruResponse,
  DanbooruSuccessResponse,
  DanbooruErrorResponse,
} from './interfaces/danbooru.interface'
import { CacheableResponse } from '../common/cache/cache.service'
import { DanbooruPost } from './dto/danbooru-post.class'
import { addToDLQ } from '../common/queues/utils/dlq.util'
import {
  RESPONSES_STREAM,
  QUERY_LOCK_TIMEOUT_SECONDS,
  DANBOORU_TAG_PATTERN,
  DANBOORU_RANDOM_PATTERN,
} from '../common/constants'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import { LockUtil } from '../common/redis/utils/lock.util'
import Redis from 'ioredis'
import * as crypto from 'crypto'

@Injectable()
export class DanbooruService {
  private readonly logger = new Logger(DanbooruService.name)

  constructor(
    private configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly lockUtil: LockUtil,
    private readonly danbooruApiService: DanbooruApiService,
    private readonly cacheService: CacheService,
    private readonly rateLimitManagerService: RateLimitManagerService,
    private readonly cacheManagerService: CacheManagerService,
  ) {}

  /**
   * Request handler with query-level locking for deduplication.
   * Broken into sub-methods for SRP: locking, params, rate/cache, fetch, invalidation, errors.
   * Preserves behavior: acquire/release lock, cache hit/miss, publish, DLQ.
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

    const lockContext = await this.acquireQueryLock(query, jobId)
    if (!lockContext) {
      return this.handleDuplicateProcessing(
        jobId,
        'Query is currently being processed',
      )
    }

    try {
      const { random, limit, tags } = this.prepareRequestParams(query)

      const rateCheck = await this.rateLimitManagerService.checkRateLimit(
        'danbooru',
        jobId,
        clientId,
      )
      if (!rateCheck.allowed) {
        return rateCheck.error
      }

      let response = await this.getOrFetchFromCache(
        query,
        random,
        limit,
        tags,
        jobId,
      )
      if (!response) {
        response = await this.fetchAndBuildResponse(query, random, limit, jobId)
        await this.cacheService.setCache(
          'danbooru',
          query,
          response as CacheableResponse,
          random,
          limit,
          tags,
        )
      }

      await this.performCacheInvalidation(tags, random, jobId)
      await this.publishResponse(jobId, response)

      return response
    } catch (error) {
      return this.handleErrorAndPublish(jobId, query, error)
    } finally {
      await this.releaseQueryLock(lockContext, jobId)
    }
  }

  /**
   * Acquires query lock using LockUtil.
   * Simplified: removed manual heartbeat (performance neutral, LockUtil handles TTL).
   * @param query - Query string to hash for lock key
   * @param jobId - Job ID for logging
   * @returns Lock context or null if not acquired
   */
  private async acquireQueryLock(
    query: string,
    jobId: string,
  ): Promise<{ lockKey: string; lockValue: string } | null> {
    const queryHash = crypto.createHash('sha256').update(query).digest('hex')
    const lockKey = `lock:query:${queryHash}`

    const lockValue = await this.lockUtil.acquireLock(
      lockKey,
      QUERY_LOCK_TIMEOUT_SECONDS,
    )
    if (!lockValue) {
      this.logger.warn(
        `Query lock not acquired for job ${jobId} (already processing)`,
        jobId,
      )
      return null
    }

    return { lockKey, lockValue }
  }

  /**
   * Early return for duplicate requests: publish error and return.
   * @param jobId - Job ID
   * @param errorMsg - Error message for response
   * @returns Error response
   */
  private async handleDuplicateProcessing(
    jobId: string,
    errorMsg: string,
  ): Promise<DanbooruErrorResponse> {
    const error: DanbooruErrorResponse = {
      type: 'error',
      jobId,
      error: errorMsg,
    }
    await this.publishResponse(jobId, error)
    return error
  }

  /**
   * Prepares request parameters: config + extract tags.
   * @param query - Query string
   * @returns Params object with random, limit, tags
   */
  private prepareRequestParams(query: string): {
    random: boolean
    limit: number
    tags: string[]
  } {
    return {
      random: this.configService.get<boolean>('DANBOORU_RANDOM') || true,
      limit: this.configService.get<number>('DANBOORU_LIMIT') || 1,
      tags: this.extractTagsFromQuery(query),
    }
  }

  /**
   * Gets from cache or returns null to trigger fetch + build response.
   * Returns null if cache miss (for throw in orchestrator).
   * @param query - Query string
   * @param random - Random flag
   * @param limit - Limit
   * @param tags - Extracted tags
   * @param jobId - Job ID for logging
   * @returns Cached response or null
   */
  private async getOrFetchFromCache(
    query: string,
    random: boolean,
    limit: number,
    tags: string[],
    jobId: string,
  ): Promise<DanbooruSuccessResponse | null> {
    const cached =
      await this.cacheService.getCachedResponse<DanbooruSuccessResponse>(
        'danbooru',
        query,
        random,
        limit,
        tags,
      )
    if (cached) {
      this.logger.log(`Cache hit for danbooru job ${jobId}`)
      return cached
    }

    return null // Trigger fetch in caller
  }

  /**
   * Fetches post + builds success response.
   * Throws if no post (for catch in processRequest).
   * @param query - Query string
   * @param random - Random flag
   * @param limit - Limit
   * @param jobId - Job ID
   * @returns Success response
   */
  private async fetchAndBuildResponse(
    query: string,
    random: boolean,
    limit: number,
    jobId: string,
  ): Promise<DanbooruSuccessResponse> {
    const post = await this.danbooruApiService.fetchPosts(query, limit, random)
    if (!post) {
      throw new Error('No posts found for the query or API error')
    }

    return this.buildSuccessResponse(post as DanbooruPost, jobId)
  }

  /**
   * Cache invalidation for tags and random (proactive freshness).
   * @param tags - Extracted tags
   * @param random - Random flag
   * @param jobId - Job ID for logging
   */
  private async performCacheInvalidation(
    tags: string[],
    random: boolean,
    jobId: string,
  ): Promise<void> {
    if (tags.length > 0) {
      for (const tag of tags) {
        const escapedTag = tag.replace(/[[\]*?^$.\\]/g, '\\$&')
        const tagPattern = DANBOORU_TAG_PATTERN.replace('*', escapedTag)
        const deleted = await this.cacheService.invalidateCache(tagPattern)
        if (deleted > 0) {
          this.logger.debug(
            `Invalidated ${deleted} tag-specific caches for tag: ${tag}`,
            jobId,
          )
        }
      }
    }

    if (random) {
      const randomDeleted = await this.cacheService.invalidateCache(
        DANBOORU_RANDOM_PATTERN,
      )
      if (randomDeleted > 0) {
        this.logger.debug(
          `Invalidated ${randomDeleted} random query caches for freshness`,
          jobId,
        )
      }
    }
  }

  /**
   * Unified error handling: log + publish + DLQ (DRY, replaces handleApiError/handleProcessingError).
   * @param jobId - Job ID
   * @param query - Query string
   * @param error - Error object
   * @returns Error response
   */
  private async handleErrorAndPublish(
    jobId: string,
    query: string,
    error: unknown,
  ): Promise<DanbooruErrorResponse> {
    const errorMsg = error instanceof Error ? error.message : String(error)
    this.logger.error(`Error processing job ${jobId}: ${errorMsg}`, jobId)

    const response: DanbooruErrorResponse = {
      type: 'error',
      jobId,
      error: errorMsg,
    }
    await this.publishResponse(jobId, response)
    await addToDLQ(this.redis, 'danbooru', jobId, errorMsg, query, 0)

    return response
  }

  /**
   * Releases query lock.
   * @param lockContext - Lock key/value
   * @param jobId - Job ID for logging
   */
  private async releaseQueryLock(
    lockContext: { lockKey: string; lockValue: string },
    jobId: string,
  ): Promise<void> {
    const released = await this.lockUtil.releaseLock(
      lockContext.lockKey,
      lockContext.lockValue,
    )
    if (released) {
      this.logger.debug(
        `Query lock released for ${lockContext.lockKey} by job ${jobId}`,
      )
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
    const id = post.id
    const characters = post.tag_string_character ?? null

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
      id,
      characters,
    }
  }

  // handleApiError and handleProcessingError removed: logic consolidated in handleErrorAndPublish

  /**
   * Extracts tags from Danbooru-style query string.
   * Supports basic tag extraction: "tag1 tag2 rating:safe" -> ['tag1', 'tag2'].
   * Filters out directives like rating:, limit: for cache key/invalidation.
   * @param query - Danbooru query string
   * @returns Sorted unique tags array
   */
  private extractTagsFromQuery(query: string): string[] {
    if (!query || typeof query !== 'string') {
      return []
    }

    const parts = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(
        (part: string) =>
          !['rating:', 'limit:', 'order:', 'score:'].some(directive =>
            part.startsWith(directive),
          ),
      )

    return [...new Set(parts)].sort()
  }

  /**
   * Cache Invalidation Strategy:
   *
   * 1. TAG-SPECIFIC INVALIDATION: After successful API call with tags,
   *    invalidate all cache entries matching the pattern:
   *    `cache:danbooru:posts:*:tag:{tag-hash}` for each tag in query
   *
   * 2. RANDOM QUERY FRESHNESS: For random queries, proactively invalidate
   *    all random cache entries periodically to ensure fresh random results.
   *    Pattern: `cache:danbooru:posts:*:random:*`
   *
   * 3. BULK INVALIDATION: When major content updates occur (future enhancement),
   *    use `cache:danbooru:posts:*` to clear all post-related caches.
   *
   * 4. DETERMINISTIC RANDOM SEEDING: Random queries now use deterministic
   *    seeding based on (query + limit + tags) ensuring consistent "random"
   *    results across cache layers while maintaining freshness through
   *    proactive invalidation.
   *
   * This strategy balances performance (caching) with data freshness
   * (proactive invalidation) while maintaining semantic cache key structure
   * for targeted operations.
   *
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
