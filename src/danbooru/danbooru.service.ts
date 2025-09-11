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
import { RateLimiterService } from './rate-limiter.service'
import { RedisStreamConsumer } from './redis-stream.consumer'
import Redis from 'ioredis'

@Injectable()
export class DanbooruService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DanbooruService.name)

  constructor(
    private configService: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly danbooruApiService: DanbooruApiService,
    private readonly cacheService: CacheService,
    private readonly rateLimiterService: RateLimiterService,
    private readonly redisStreamConsumer: RedisStreamConsumer,
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
    this.logger.log(`Processing job ${jobId} for query: ${query}`, jobId)

    try {
      const random = this.configService.get<boolean>('DANBOORU_RANDOM') || true

      const isAllowed = await this.checkRateLimit(jobId, clientId)
      if (!isAllowed) {
        const errorData: DanbooruErrorResponse = {
          type: 'error',
          jobId,
          error: 'Rate limit exceeded. Try again in 1 minute.',
        }
        await this.publishResponse(jobId, errorData)
        return errorData
      }

      const responseOrNull = await this.getCachedOrFetch(query, random, jobId)
      if (!responseOrNull) {
        const errorMessage = 'No posts found for the query or API error'
        return await this.handleApiError(errorMessage, jobId, query)
      }

      const responseData = responseOrNull
      await this.publishResponse(jobId, responseData)
      // Cache the response for 1h if not random
      if (!random) {
        await this.cacheService.setCache(query, responseData)
      }
      return responseData
    } catch (error: unknown) {
      return await this.handleProcessingError(error, jobId, query)
    }
  }

  async publishResponse(jobId: string, data: DanbooruResponse) {
    const responseKey = RESPONSES_STREAM
    const message = { ...data }
    const entries = Object.entries(message).flatMap(([k, v]) => [
      k,
      v == null ? 'null' : v.toString(),
    ])
    await this.redis.xadd(responseKey, '*', ...entries)
    this.logger.log(`Published response for job ${jobId} to ${responseKey}`)
  }

  private async checkRateLimit(
    jobId: string,
    clientId?: string,
  ): Promise<boolean> {
    const rateLimitPerMinute =
      this.configService.get<number>('RATE_LIMIT_PER_MINUTE') || 60
    const rateKey = clientId
      ? `rate:danbooru:${clientId}`
      : `rate:danbooru:global`
    const isAllowed = await this.rateLimiterService.checkRateLimit(
      rateKey,
      rateLimitPerMinute,
      60, // 1 minute window
    )
    if (!isAllowed) {
      this.logger.warn(
        `Rate limit exceeded for job ${jobId} (client: ${clientId || 'global'})`,
        jobId,
      )
    }
    return isAllowed
  }

  private async getCachedOrFetch(
    query: string,
    random: boolean,
    jobId: string,
  ): Promise<DanbooruSuccessResponse | null> {
    // Skip cache for random queries
    let cached: DanbooruSuccessResponse | null = null
    if (!random) {
      cached = await this.cacheService.getCachedResponse(query)
      if (cached) {
        this.logger.log(`Cache hit for job ${jobId}`, jobId)
        return cached
      }
    }

    const limit = this.configService.get<number>('DANBOORU_LIMIT') || 1
    const post = await this.danbooruApiService.fetchPosts(query, limit, random)
    if (!post) {
      return null
    }

    return this.buildSuccessResponse(post, jobId)
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
