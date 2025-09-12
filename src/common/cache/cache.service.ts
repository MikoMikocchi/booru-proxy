import { Injectable, Inject, Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'

export interface CacheableResponse {
  [key: string]: any
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name)
  private readonly ttl: number

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private configService: ConfigService,
  ) {
    this.ttl = this.configService.get<number>('CACHE_TTL_SECONDS') || 3600
  }

  async getCachedResponse<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    random: boolean,
  ): Promise<T | null> {
    const key = this.getCacheKey(apiPrefix, query, random)
    const cached = await this.redis.get(key)
    if (cached) {
      try {
        return JSON.parse(cached) as T
      } catch (error) {
        this.logger.warn(
          `Failed to parse cached data for key ${key}: ${error.message}`,
        )
        await this.redis.del(key) // Clean invalid cache
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
    await this.redis.setex(key, expiresIn, JSON.stringify(response))
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
    const deleted = await this.redis.del(key)
    if (deleted > 0) {
      this.logger.debug(
        `Deleted cache for ${apiPrefix} query: ${query} (random: ${random})`,
      )
    }
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
    const pattern = `cache:*` // Full pattern, but filter by prefix in app
    const keys = await this.redis.keys(pattern)
    let deletedCount = 0
    for (const key of keys) {
      if (key.includes(apiPrefix.toLowerCase())) {
        await this.redis.del(key)
        deletedCount++
      }
    }
    this.logger.log(`Invalidated ${deletedCount} cache keys for ${apiPrefix}`)
    return deletedCount
  }
}
