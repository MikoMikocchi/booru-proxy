import { Injectable, Inject, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'

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
  ): Promise<T | null> {
    const key = this.getCacheKey(apiPrefix, query, random)
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
    customTtl?: number,
  ): Promise<void> {
    const key = this.getCacheKey(apiPrefix, query, random)
    const expiresIn = customTtl || this.ttl
    await this.setex(key, expiresIn, JSON.stringify(response))
    this.logger.debug(
      `Cached response for ${apiPrefix} query: ${query} (random: ${random}, ttl: ${expiresIn}s)`,
    )
  }

  async deleteCache(
    apiPrefix: string,
    query: string,
    random: boolean,
  ): Promise<void> {
    const key = this.getCacheKey(apiPrefix, query, random)
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
    customTtl?: number,
  ): Promise<T | null> {
    const cached = await this.getCachedResponse<T>(apiPrefix, query, random)
    if (cached) {
      return cached
    }

    const freshData = await fetchFn()
    if (freshData) {
      await this.setCache(apiPrefix, query, freshData, random, customTtl)
    }
    return freshData
  }

  private getCacheKey(
    apiPrefix: string,
    query: string,
    random: boolean,
  ): string {
    // Normalize query: trim, lowercase, normalize spaces
    const normalizedQuery = query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()

    // Include API prefix and random flag for separation
    const cacheKey = `${apiPrefix}:${normalizedQuery}|random=${random ? 1 : 0}`
    const hash = crypto.createHash('md5').update(cacheKey).digest('hex')
    return `cache:${hash}`
  }

  // Multi-API support: get all keys matching prefix for invalidation
  async invalidateByPrefix(apiPrefix: string): Promise<number> {
    if (this.backend === 'memcached') {
      this.logger.warn(
        `Bulk invalidation not fully supported for Memcached. Implement tag-based if needed.`,
      )
      return 0
    }
    const pattern = `cache:*`
    const keys = await this.redis.keys(pattern)
    let deletedCount = 0
    for (const key of keys) {
      if (key.includes(apiPrefix.toLowerCase())) {
        await this.del(key)
        deletedCount++
      }
    }
    this.logger.log(`Invalidated ${deletedCount} cache keys for ${apiPrefix}`)
    return deletedCount
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
