import { Injectable, Logger } from '@nestjs/common'
import { CacheService, CacheableResponse } from './cache.service'

@Injectable()
export class CacheManagerService {
  private readonly logger = new Logger(CacheManagerService.name)

  constructor(private cacheService: CacheService) {}

  async getOrFetch<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    random: boolean,
    jobId: string,
    fetchFn: () => Promise<T | null>,
    customTtl?: number,
  ): Promise<T | null> {
    let cached: T | null = null

    // Only cache non-random queries to avoid stale random results
    if (!random) {
      cached = await this.cacheService.getCachedResponse<T>(
        apiPrefix,
        query,
        random,
      )
      if (cached) {
        this.logger.log(
          `Cache hit for ${apiPrefix} job ${jobId}: query length ${query.length}`,
        )
        return cached
      }
    }

    // Cache miss or random query - fetch from source
    this.logger.debug(
      `${apiPrefix} cache miss for job ${jobId}, fetching fresh data`,
    )
    const freshData = await fetchFn()

    if (freshData && !random) {
      // Cache successful non-random responses
      await this.cacheService.setCache(
        apiPrefix,
        query,
        freshData,
        random,
        customTtl,
      )
      this.logger.debug(`${apiPrefix} cached fresh response for job ${jobId}`)
    }

    return freshData
  }

  async cacheResponseIfNeeded<T extends CacheableResponse>(
    apiPrefix: string,
    query: string,
    response: T,
    random: boolean,
    customTtl?: number,
  ): Promise<void> {
    if (!random && response) {
      await this.cacheService.setCache(
        apiPrefix,
        query,
        response,
        random,
        customTtl,
      )
    }
  }

  async invalidateCache(
    apiPrefix: string,
    query?: string,
    random?: boolean,
  ): Promise<void> {
    if (query && random !== undefined) {
      await this.cacheService.deleteCache(apiPrefix, query, random)
      this.logger.log(
        `Invalidated specific cache for ${apiPrefix}: ${query} (random: ${random})`,
      )
    } else {
      const deletedCount = await this.cacheService.invalidateByPrefix(apiPrefix)
      this.logger.log(
        `Bulk invalidated ${deletedCount} cache entries for ${apiPrefix}`,
      )
    }
  }

  // Multi-API support: get cache stats (for monitoring)
  async getCacheStats(
    apiPrefix: string,
  ): Promise<{ hits: number; misses: number; size: number }> {
    // Implementation for cache metrics - can use Redis INFO or custom counters
    // For now return mock stats - extend with Redis monitoring
    return {
      hits: 0, // Track with Redis counters in production
      misses: 0,
      size: 0, // Cache size monitoring - implement with Redis INFO in production
    }
  }
}
