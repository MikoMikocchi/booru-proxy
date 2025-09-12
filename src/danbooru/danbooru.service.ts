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
} from '../common/constants'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import Redis from 'ioredis'

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

  async processRequest(
    jobId: string,
    query: string,
    clientId?: string,
  ): Promise<DanbooruResponse> {
    this.logger.log(
      `Processing job ${jobId} for query: ${query.replace(/./g, '*')}`,
      jobId,
    )

    try {
      const random = this.configService.get<boolean>('DANBOORU_RANDOM') || true

      // Use extracted DTO from validation (but since processRequest doesn't have jobData, adjust to use parameters and call validation separately if needed)
      // For now, assume validation done in consumer, here start from rate limit
      const rateCheck = await this.rateLimitManagerService.checkRateLimit(
        'danbooru',
        jobId,
        clientId,
      )
      if (!rateCheck.allowed) {
        await this.publishResponse(jobId, rateCheck.error)
        return rateCheck.error
      }

      // Direct cache check using CacheService for compatibility
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

      // Direct cache set using CacheService for compatibility
      if (!random) {
        await this.cacheService.setCache(
          'danbooru',
          query,
          responseData,
          random,
        )
      }

      return responseData
    } catch (error: unknown) {
      return await this.handleProcessingError(error, jobId, query)
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
}
