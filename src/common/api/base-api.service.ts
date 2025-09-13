import { Injectable, Logger, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios, { AxiosInstance } from 'axios'
import axiosRetry from 'axios-retry'
import * as crypto from 'crypto'
import Redis from 'ioredis'
import { ApiResponse, ApiConfig } from './base-api.interface'
import { CacheService, CacheableResponse } from '../cache/cache.service'

export type { ApiConfig, ApiResponse } from './base-api.interface'

@Injectable()
export abstract class BaseApiService {
  protected readonly logger = new Logger(this.constructor.name)
  protected readonly httpClient: AxiosInstance

  constructor(
    protected configService: ConfigService,
    @Inject('REDIS_CLIENT') protected redis?: Redis,
    @Inject(CacheService) protected cacheService?: CacheService, // Optional cache injection
  ) {
    this.httpClient = axios.create(this.getApiConfig())

    // Configure axios-retry with exponential backoff and custom conditions
    axiosRetry(this.httpClient, {
      retries: this.getApiConfig().retryAttempts || 3,
      retryDelay: (retryCount, error) => {
        // Check for 429 retry-after header
        if (
          error.response?.status === 429 &&
          error.response.headers['retry-after']
        ) {
          const retryAfterStr = error.response?.headers?.['retry-after'] as
            | string
            | undefined
          const retryAfter = retryAfterStr ? parseInt(retryAfterStr, 10) : NaN
          if (!isNaN(retryAfter)) {
            this.logger.warn(
              `Respecting 429 retry-after header: ${retryAfter} seconds`,
            )
            return retryAfter * 1000 // Convert to ms
          }
        }
        // Fallback to exponential backoff with jitter
        return axiosRetry.exponentialDelay(retryCount) + Math.random() * 1000
      },
      retryCondition: error => {
        const status = error.response?.status
        return (
          error.code === 'ECONNABORTED' ||
          status === 429 ||
          (typeof status === 'number' && status >= 500)
        )
      },
    })
  }

  protected abstract getApiConfig(): ApiConfig
  protected abstract getBaseEndpoint(): string

  async fetchPosts(
    query: string,
    limit = 1,
    random = true,
  ): Promise<Record<string, unknown> | null> {
    const apiPrefix = this.getName()

    if (this.cacheService && !random) {
      const cached = await this.cacheService.getCachedResponse(
        apiPrefix,
        query,
        random,
      )
      if (cached) {
        this.logger.debug(
          `${this.constructor.name}: Cache hit for query: ${query}`,
        )
        return cached
      }
    }

    try {
      this.logger.log(
        `${this.constructor.name}: Fetching posts for query: ${query}`,
      )
      const endpoint = this.buildEndpoint(query, limit, random)
      const response = await this.httpClient.get<ApiResponse>(endpoint)
      const rawPosts = response.data?.data
      this.logger.log(
        `${this.constructor.name}: Response data type: ${typeof response.data}`,
      )
      if (response.data && typeof response.data === 'object') {
        this.logger.log(
          `${this.constructor.name}: Sample response structure: ${JSON.stringify(Object.keys(response.data).slice(0, 5))}`,
        )
      }

      if (!rawPosts || !Array.isArray(rawPosts) || rawPosts.length === 0) {
        this.logger.warn(
          `${this.constructor.name}: No posts found for query: ${query}`,
        )
        return null
      }

      const post = rawPosts[0] as Record<string, unknown>
      this.logger.log(
        `${this.constructor.name}: Post data type before sanitize: ${typeof post}`,
      )
      const sanitizedPost = this.sanitizeResponse(post)

      if (!random && this.cacheService) {
        await this.cacheService.setCache(
          apiPrefix,
          query,
          sanitizedPost as CacheableResponse,
          random,
        )
      }

      return sanitizedPost
    } catch (error) {
      const err = error as Error
      this.logger.error(
        `${this.constructor.name}: API error for query ${query}: ${err.message}`,
        err.stack,
      )
      return null
    }
  }

  protected buildEndpoint(
    query: string,
    limit: number,
    random: boolean,
  ): string {
    let endpoint = `${this.getBaseEndpoint()}?tags=${encodeURIComponent(query)}&limit=${limit}`
    if (random) {
      endpoint += '&random=true'
    }
    return endpoint
  }

  protected getCacheKey(
    apiPrefix: string,
    query: string,
    random: boolean,
  ): string {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
    const key = `${apiPrefix}:${normalized}|random=${random ? 1 : 0}`
    return key
  }

  protected async cacheResponse(
    apiPrefix: string,
    query: string,
    data: CacheableResponse,
    random: boolean,
    ttl?: number,
  ): Promise<void> {
    if (this.cacheService) {
      await this.cacheService.setCache(apiPrefix, query, data, random, ttl)
    } else if (this.redis) {
      const key = this.getCacheKey(apiPrefix, query, random)
      const expiresIn =
        ttl || this.configService.get<number>('CACHE_TTL_SECONDS') || 3600
      await this.redis.setex(key, expiresIn, JSON.stringify(data))
      this.logger.debug(
        `${this.constructor.name}: Direct Redis cache for key: ${key}`,
      )
    }
  }

  /**
   * Invalidate cache entries for the API using pattern-based matching
   * @param apiPrefix - API identifier (e.g., 'danbooru', 'gelbooru')
   * @param query - Optional specific query to invalidate
   * @param random - Optional flag to target random vs deterministic caches
   * @returns Number of invalidated cache entries
   */
  async invalidateCache(
    apiPrefix: string,
    query?: string,
    random?: boolean,
  ): Promise<number> {
    if (!this.cacheService) {
      this.logger.warn(
        `${this.constructor.name}: CacheService not available for invalidation`,
      )
      return 0
    }

    let deletedCount = 0

    // Generate dynamic cache patterns based on apiPrefix
    const cachePrefix = 'cache' // From constants.CACHE_PREFIX
    const basePattern = `${cachePrefix}:${apiPrefix}:*`

    // 1. Always invalidate all API-specific caches if no query provided
    if (!query) {
      deletedCount += await this.cacheService.invalidate(basePattern)
      this.logger.debug(
        `${this.constructor.name}: Invalidated all caches for ${apiPrefix} (${deletedCount} keys)`,
      )
      return deletedCount
    }

    // 2. Query-specific invalidation with optional random filtering
    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ')
    const queryHash = crypto
      .createHash('md5')
      .update(normalizedQuery)
      .digest('hex')

    this.logger.log(
      `${this.constructor.name}: Query hash type: ${typeof queryHash}, Length: ${queryHash.length}`,
    )
    // Build specific pattern for this query
    let queryPattern = `${cachePrefix}:${apiPrefix}:posts:${queryHash}`

    if (random !== undefined) {
      queryPattern += `:random=${random ? 1 : 0}`
    }

    // Add wildcard for limit and tag suffixes
    queryPattern += `:*`

    deletedCount += await this.cacheService.invalidate(queryPattern)

    // 3. Also invalidate broader API posts pattern for related caches
    const apiPostsPattern = `${cachePrefix}:${apiPrefix}:posts:*`
    deletedCount += await this.cacheService.invalidate(apiPostsPattern)

    this.logger.debug(
      `${this.constructor.name}: Invalidated ${deletedCount} cache entries for ${apiPrefix} query "${normalizedQuery.substring(0, 20)}..." (random: ${random})`,
    )

    return deletedCount
  }

  protected sanitizeResponse(data: unknown): Record<string, unknown> {
    this.logger.log(
      `${this.constructor.name}: Sanitizing data type: ${typeof data}`,
    )
    if (data && typeof data === 'object' && data !== null) {
      const objData = data as Record<string, unknown>
      this.logger.log(
        `${this.constructor.name}: Sanitizing keys: ${JSON.stringify(Object.keys(objData).slice(0, 5))}`,
      )
    }
    // Default sanitization - override in subclasses for specific fields
    if (data && typeof data === 'object' && data !== null) {
      const sanitized: Record<string, unknown> = { ...data }
      // Sanitize common string fields (override in child classes)
      ;[
        'tag_string_general',
        'tag_string_artist',
        'tag_string_copyright',
        'source',
      ].forEach(field => {
        const fieldValue = sanitized[field]
        if (typeof fieldValue === 'string') {
          sanitized[field] = this.sanitizeString(fieldValue)
        }
      })
      return sanitized
    }
    return data as Record<string, unknown>
  }

  protected sanitizeString(str: string): string {
    // Basic XSS protection - use xss library in production
    return str
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .trim()
  }

  protected getName(): string {
    return this.constructor.name.replace('ApiService', '')
  }
}
