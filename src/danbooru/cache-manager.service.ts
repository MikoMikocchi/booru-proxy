import { Injectable, Logger } from '@nestjs/common'
import { CacheService } from './cache.service'
import { DanbooruSuccessResponse } from './interfaces/danbooru.interface'

@Injectable()
export class CacheManagerService {
  private readonly logger = new Logger(CacheManagerService.name)

  constructor(private cacheService: CacheService) {}

  async getCachedOrFetch(
    query: string,
    random: boolean,
    jobId: string,
  ): Promise<DanbooruSuccessResponse | null> {
    let cached: DanbooruSuccessResponse | null = null
    if (!random) {
      cached = await this.cacheService.getCachedResponse(query, random)
      if (cached) {
        this.logger.log(`Cache hit for job ${jobId}`)
        return cached
      }
    }

    return null // Caller will fetch from API
  }

  async cacheResponseIfNeeded(
    query: string,
    response: DanbooruSuccessResponse,
    random: boolean,
  ): Promise<void> {
    if (!random) {
      await this.cacheService.setCache(query, response, random)
    }
  }
}
