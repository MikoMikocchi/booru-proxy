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
import { addToDLQ } from './utils/dlq.util'
import {
  REQUESTS_STREAM,
  RESPONSES_STREAM,
  DLQ_STREAM,
} from '../common/constants'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from './cache.service'
import { RateLimitManagerService } from './rate-limit-manager.service'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { CacheManagerService } from './cache-manager.service'
import Redis from 'ioredis'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DanbooruService.name)

  constructor(
    private configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly danbooruApiService: DanbooruApiService,
    private readonly cacheService: CacheService,
    private readonly rateLimitManagerService: RateLimitManagerService,
    private readonly redisStreamConsumer: RedisStreamConsumer,
    private readonly cacheManagerService: CacheManagerService,
  ) {}

  async onModuleInit() {
    await this.redisStreamConsumer.onModuleInit()
  }

  onModuleDestroy() {
    this.redisStreamConsumer.onModuleDestroy()
  }

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
        jobId,
        clientId,
      )
      if (!rateCheck.allowed) {
        await this.publishResponse(jobId, rateCheck.error)
        return rateCheck.error
      }

      const responseOrNull = await this.cacheManagerService.getCachedOrFetch(
        query,
        random,
        jobId,
      )
      if (responseOrNull) {
        await this.publishResponse(jobId, responseOrNull)
        return responseOrNull
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
        await addToDLQ(this.redis, jobId, errorMessage, query)
        return error
      }

      const responseData = this.buildSuccessResponse(post, jobId)
      await this.publishResponse(jobId, responseData)

      await this.cacheManagerService.cacheResponseIfNeeded(
        query,
        responseData,
        random,
      )

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
    await addToDLQ(this.redis, jobId, errorMessage, query)
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
    await addToDLQ(this.redis, jobId, errorMessage, query)
    return errorData
  }
}
