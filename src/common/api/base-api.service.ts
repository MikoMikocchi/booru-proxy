import { Injectable, Logger, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios, { AxiosInstance, AxiosError } from 'axios'
import axiosRetry from 'axios-retry'
import Redis from 'ioredis'
import { ApiResponse, ApiConfig } from './base-api.interface'
import { CacheService } from '../cache/cache.service'

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
          const retryAfter = parseInt(error.response.headers['retry-after'], 10)
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

  // Legacy method - axios-retry now handles retries
  protected setupRetryInterceptor(): void {
    // No-op: axios-retry interceptor is configured in constructor
  }

  async fetchPosts(
    query: string,
    limit = 1,
    random = true,
  ): Promise<any | null> {
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
      const posts = response.data?.data

      if (!posts || posts.length === 0) {
        this.logger.warn(
          `${this.constructor.name}: No posts found for query: ${query}`,
        )
        return null
      }

      const post = posts[0]
      const sanitizedPost = this.sanitizeResponse(post)

      if (!random && this.cacheService) {
        await this.cacheService.setCache(
          apiPrefix,
          query,
          sanitizedPost,
          random,
        )
      }

      return sanitizedPost
    } catch (error) {
      this.logger.error(
        `${this.constructor.name}: API error for query ${query}: ${(error as Error).message}`,
        error.stack,
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
    data: any,
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
    const queryHash = require('crypto')
      .createHash('md5')
      .update(normalizedQuery)
      .digest('hex')

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

  protected sanitizeResponse(data: any): any {
    // Default sanitization - override in subclasses for specific fields
    if (typeof data === 'object') {
      const sanitized = { ...data }
      // Sanitize common string fields (override in child classes)
      ;[
        'tag_string_general',
        'tag_string_artist',
        'tag_string_copyright',
        'source',
      ].forEach(field => {
        if (typeof sanitized[field] === 'string') {
          sanitized[field] = this.sanitizeString(sanitized[field])
        }
      })
      return sanitized
    }
    return data
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
