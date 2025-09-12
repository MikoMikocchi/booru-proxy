import { Injectable, Inject, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import {
  CACHE_PREFIX,
  DANBOORU_API_PREFIX,
  POSTS_RESOURCE,
  RANDOM_SUFFIX,
  TAG_SUFFIX,
  LIMIT_SUFFIX,
  RANDOM_SEED_SUFFIX,
  DANBOORU_POSTS_PATTERN,
  DANBOORU_TAG_PATTERN,
  DANBOORU_RANDOM_PATTERN,
  DANBOORU_ALL_PATTERN,
} from '../constants'

export interface CacheableResponse {
  [key: string]: any
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name)
  private readonly ttl: number
  private backend: string
  private redis?: any
  private memcached?: any

  constructor(
    @Inject('REDIS_CLIENT') private readonly injectedRedis: any,
    private configService: ConfigService,
  ) {
    this.ttl = this.configService.get<number>('CACHE_TTL_SECONDS') || 3600
    this.backend = this.configService.get<string>('CACHE_BACKEND') || 'redis'
    this.initializeBackend()
  }

  private initializeBackend() {
    if (this.backend === 'redis') {
      this.redis = this.injectedRedis
    } else if (this.backend === 'memcached') {
      const memjs = require('memjs')
      const servers =
        this.configService.get<string>('MEMCACHED_SERVERS') || '127.0.0.1:11211'
      this.memcached = memjs.Client.create(servers)
    } else {
      this.logger.warn(
        `Unsupported cache backend: ${this.backend}. Using Redis fallback.`,
      )
      this.backend = 'redis'
      this.redis = this.injectedRedis
    }
  }

  async getCachedResponse<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    random: boolean,
    limit?: number,
    tags?: string[],
  ): Promise<T | null> {
    const key = this.getCacheKey(apiPrefix, query, random, limit, tags)
    const cached = await this.get(key)
    if (cached) {
      try {
        return JSON.parse(cached) as T
      } catch (error) {
        this.logger.warn(
          `Failed to parse cached data for key ${key}: ${error.message}`,
        )
        await this.del(key) // Clean invalid cache
        return null
      }
    }
    return null
  }

  async setCache<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    response: T,
    random: boolean,
    limit?: number,
    tags?: string[],
    customTtl?: number,
  ): Promise<void> {
    const key = this.getCacheKey(apiPrefix, query, random, limit, tags)
    const expiresIn = customTtl || this.ttl
    await this.setex(key, expiresIn, JSON.stringify(response))
    this.logger.debug(
      `Cached response for ${apiPrefix} query: ${query} (random: ${random}, ttl: ${expiresIn}s, key: ${key})`,
    )
  }

  async deleteCache(
    apiPrefix: string,
    query: string,
    random: boolean,
    limit?: number,
    tags?: string[],
  ): Promise<void> {
    const key = this.getCacheKey(apiPrefix, query, random, limit, tags)
    await this.del(key)
    this.logger.debug(
      `Deleted cache for ${apiPrefix} query: ${query} (random: ${random})`,
    )
  }

  async getOrSet<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    random: boolean,
    fetchFn: () => Promise<T | null>,
    limit?: number,
    tags?: string[],
    customTtl?: number,
  ): Promise<T | null> {
    const cached = await this.getCachedResponse<T>(
      apiPrefix,
      query,
      random,
      limit,
      tags,
    )
    if (cached) {
      return cached
    }

    const freshData = await fetchFn()
    if (freshData) {
      await this.setCache(
        apiPrefix,
        query,
        freshData,
        random,
        limit,
        tags,
        customTtl,
      )
    }
    return freshData
  }

  private getCacheKey(
    apiPrefix: string,
    query: string,
    random: boolean,
    limit?: number,
    tags?: string[],
  ): string {
    /**
     * Unified cache key generation strategy:
     * Format: cache:{api}:{resource}:{query-hash}:{limit}:{random-seed}:{tag-hash}
     *
     * - api: API name (e.g., 'danbooru')
     * - resource: Resource type (e.g., 'posts')
     * - query-hash: MD5 hash of normalized query string
     * - limit: Query limit (deterministic, no hashing needed)
     * - random-seed: Deterministic seed from limit + tags for consistent random results
     * - tag-hash: MD5 hash of sorted tags for tag-specific invalidation
     *
     * This structure enables:
     * 1. Pattern-based invalidation (e.g., invalidate all posts for a tag)
     * 2. Deterministic random results (same limit/tags = same "random" results)
     * 3. Query-specific caching with semantic structure
     * 4. Backward compatibility with existing hash-based keys
     */

    // Normalize query: trim, lowercase, normalize spaces
    const normalizedQuery = query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()

    // Generate query hash
    const queryHash = crypto
      .createHash('md5')
      .update(normalizedQuery)
      .digest('hex')

    // Build base key structure
    let keyParts = [CACHE_PREFIX, apiPrefix, POSTS_RESOURCE, queryHash]

    // Add limit if provided (deterministic)
    if (limit !== undefined) {
      keyParts.push(`${LIMIT_SUFFIX}:${limit}`)
    }

    // Generate deterministic random seed if random is true
    if (random) {
      const seed = this.generateRandomSeed(query, limit, tags)
      keyParts.push(`${RANDOM_SEED_SUFFIX}:${seed}`)
    }

    // Add tag hash for tag-specific invalidation
    if (tags && tags.length > 0) {
      const sortedTags = tags.sort().join(',')
      const tagHash = crypto.createHash('md5').update(sortedTags).digest('hex')
      keyParts.push(`${TAG_SUFFIX}:${tagHash}`)
    }

    return keyParts.join(':')
  }

  private generateRandomSeed(
    query: string,
    limit?: number,
    tags?: string[],
  ): string {
    /**
     * Generate deterministic random seed from query parameters
     * Ensures same inputs produce same "random" results across cache layers
     */
    const seedParts = [
      query.trim(),
      limit?.toString() || 'default',
      (tags || []).sort().join(',') || 'no-tags',
    ]

    const seedString = seedParts.join('|')
    return crypto
      .createHash('sha256')
      .update(seedString)
      .digest('hex')
      .slice(0, 16)
  }

  /**
   * Pattern-based cache invalidation using Redis KEYS/SCAN
   * Supports wildcards for bulk operations (e.g., invalidate all posts for a tag)
   *
   * @param keyPattern - Pattern to match (e.g., 'cache:danbooru:posts:*:tag:abc123')
   * @returns Number of deleted keys
   */
  async invalidateCache(keyPattern: string): Promise<number> {
    if (this.backend === 'memcached') {
      this.logger.warn(
        `Pattern-based invalidation not supported for Memcached. Implement tag-based if needed.`,
      )
      return 0
    }

    try {
      // Use SCAN for production (KEYS blocks on large datasets)
      // For now, use KEYS for simplicity - consider SCAN implementation later
      const keys = await this.redis.keys(keyPattern)
      let deletedCount = 0

      if (keys.length === 0) {
        this.logger.debug(`No cache keys matched pattern: ${keyPattern}`)
        return 0
      }

      // Batch delete for efficiency (Redis pipeline)
      const pipeline = this.redis.pipeline()
      for (const key of keys) {
        pipeline.del(key)
      }

      const results = await pipeline.exec()
      deletedCount = results.filter(
        (result: [string, number]) => result[1] === 1,
      ).length

      this.logger.log(
        `Invalidated ${deletedCount} cache keys matching pattern: ${keyPattern}`,
      )

      return deletedCount
    } catch (error) {
      this.logger.error(
        `Failed to invalidate cache with pattern ${keyPattern}: ${error.message}`,
      )
      return 0
    }
  }

  // Legacy method - kept for backward compatibility
  async invalidateByPrefix(apiPrefix: string): Promise<number> {
    const pattern = `${CACHE_PREFIX}:${apiPrefix}:*`
    return await this.invalidateCache(pattern)
  }

  // Backend-specific operations
  private async get(key: string): Promise<string | null> {
    if (this.backend === 'redis') {
      return await this.redis.get(key)
    } else if (this.backend === 'memcached') {
      try {
        const value = await this.memcached.get(key)
        return value ? value.toString() : null
      } catch (error) {
        this.logger.error(`Memcached get error: ${error.message}`)
        return null
      }
    }
    return null
  }

  private async setex(
    key: string,
    expiresIn: number,
    value: string,
  ): Promise<void> {
    if (this.backend === 'redis') {
      await this.redis.setex(key, expiresIn, value)
    } else if (this.backend === 'memcached') {
      try {
        await this.memcached.set(key, value, { expires: expiresIn })
      } catch (error) {
        this.logger.error(`Memcached set error: ${error.message}`)
      }
    }
  }

  private async del(key: string): Promise<void> {
    if (this.backend === 'redis') {
      await this.redis.del(key)
    } else if (this.backend === 'memcached') {
      try {
        await this.memcached.delete(key)
      } catch (error) {
        this.logger.error(`Memcached delete error: ${error.message}`)
      }
    }
  }

  // Generic getOrFetch method for unified caching logic
  async getOrFetch<T = any>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    let cached = await this.get(key)
    if (cached) {
      try {
        this.logger.debug(`Cache hit for key: ${key}`)
        return JSON.parse(cached) as T
      } catch (error) {
        this.logger.warn(`Invalid cached data for key ${key}, fetching fresh`)
        await this.del(key)
      }
    }

    this.logger.debug(`Cache miss for key: ${key}, fetching data`)
    const data = await fetchFn()
    const jsonValue = JSON.stringify(data)
    const expiresIn = ttl || this.ttl
    await this.setex(key, expiresIn, jsonValue)
    this.logger.debug(
      `Cached fresh data for key: ${key} with TTL: ${expiresIn}s`,
    )
    return data
  }
}
