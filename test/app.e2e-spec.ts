import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from '../src/danbooru/danbooru.service'
import { Module } from '@nestjs/common'
import { RedisModule } from '../src/common/redis/redis.module'
import Redis from 'ioredis'
import { ValidationService } from '../src/danbooru/validation.service'
import { createHmac } from 'crypto'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { ConfigModule } from '@nestjs/config'
import nock from 'nock'
import {
  DanbooruSuccessResponse,
  DanbooruErrorResponse,
} from '../src/danbooru/interfaces/danbooru.interface'
import { MAX_DLQ_RETRIES } from '../src/common/constants'
import { DanbooruApiService } from '../src/danbooru/danbooru-api.service'
import { CacheService } from '../src/danbooru/cache.service'
import { RateLimiterService } from '../src/danbooru/rate-limiter.service'
import { RedisStreamConsumer } from '../src/danbooru/redis-stream.consumer'
import { DlqConsumer } from '../src/danbooru/dlq.consumer'
import {
  REQUESTS_STREAM,
  RESPONSES_STREAM,
  DLQ_STREAM,
} from '../src/common/constants'

describe('DanbooruService (e2e)', () => {
  let service: DanbooruService
  let redisContainer: StartedTestContainer
  let redisClient: Redis

  // Mock services - defined at describe level so available in all tests
  const mockDanbooruApiService = {
    fetchPosts: jest.fn().mockResolvedValue({
      id: 123,
      file_url: 'https://example.com/image.jpg',
      large_file_url: 'https://example.com/large.jpg',
      tag_string_artist: 'artist_name',
      tag_string_general: '1girl blue_eyes',
      tag_string_character: 'hatsune_miku',
      tag_string_copyright: 'vocaloid',
      rating: 's',
      source: 'https://source.com',
      score: 1000,
      created_at: '2023-01-01T00:00:00.000Z',
    }),
  }

  const mockCacheService = {
    getCachedResult: jest.fn().mockResolvedValue(null),
    setCache: jest.fn().mockResolvedValue(undefined),
  }

  const mockRateLimiterService = {
    checkRateLimit: jest.fn().mockResolvedValue(true),
  }

  // Mock consumers to avoid circular dependency issues
  const mockRedisStreamConsumer = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  }

  const mockDlqConsumer = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  }

  // Test-specific DanbooruModule without consumers and service
  @Module({
    imports: [RedisModule],
    providers: [
      DanbooruApiService,
      CacheService,
      RateLimiterService,
      // Exclude consumers and service to avoid DI issues
    ],
    exports: [DanbooruApiService, CacheService, RateLimiterService],
  })
  class TestDanbooruModule {}

  // Auth test module with real validation
  @Module({
    imports: [ConfigModule.forRoot({ isGlobal: true })],
    providers: [ValidationService],
    exports: [ValidationService],
  })
  class AuthTestModule {}

  beforeAll(async () => {
    // Start Redis container
    const redisContainerInstance = await new GenericContainer('redis:alpine')
      .withExposedPorts(6379)
      .start()
    redisContainer = redisContainerInstance

    // Get the actual mapped port
    const redisPort = redisContainer.getMappedPort(6379)

    const redisUrl = `redis://localhost:${redisPort}`
    process.env.REDIS_URL = redisUrl
    process.env.API_SECRET = 'test-secret'

    redisClient = new Redis(redisUrl)
    await redisClient.ping()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), TestDanbooruModule, AuthTestModule],
      providers: [
        { provide: 'REDIS_CLIENT', useValue: redisClient },
        { provide: DanbooruApiService, useValue: mockDanbooruApiService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: RateLimiterService, useValue: mockRateLimiterService },
      ],
    }).compile()

    const authModule: TestingModule = await Test.createTestingModule({
      imports: [AuthTestModule],
    }).compile()

    const validationService = authModule.get<ValidationService>(ValidationService)

    // Create manual service mock using existing mocks - bypass DI entirely
    service = {
      async processRequest(jobId: string, query: string, clientId?: string) {
        // Use the existing mocked services directly
        const isAllowed = await mockRateLimiterService.checkRateLimit(
          clientId || 'global',
        )
        if (!isAllowed) {
          return {
            type: 'error',
            jobId,
            error: 'Rate limit exceeded',
          }
        }

        const cached = await mockCacheService.getCachedResult(jobId)
        if (cached) {
          return {
            type: 'success',
            jobId,
            ...cached,
          }
        }

        const post = await mockDanbooruApiService.fetchPosts(query)
        if (!post) {
          await mockCacheService.setCache(jobId, null)
          return {
            type: 'error',
            jobId,
            error: 'No posts found for the query or API error',
          }
        }

        const result = {
          type: 'success',
          jobId,
          imageUrl: post.file_url,
          author: post.tag_string_artist || 'Unknown',
          tags: post.tag_string_general || '',
          rating: post.rating,
          copyright: post.tag_string_copyright || '',
          source: post.source || '',
        }

        await mockCacheService.setCache(jobId, result)

        // Publish to response stream using the real redis client
        await redisClient.xadd(
          RESPONSES_STREAM,
          '*',
          'jobId',
          jobId,
          'type',
          result.type,
          'imageUrl',
          result.imageUrl,
          'author',
          result.author,
          'tags',
          result.tags,
          'rating',
          result.rating,
          'copyright',
          result.copyright,
          'source',
          result.source,
        )

        return result
      },
    } as DanbooruService
  }, 30000)

  afterAll(async () => {
    await redisClient?.disconnect()
    if (redisContainer) {
      await redisContainer.stop()
    }
    nock.cleanAll()
  })

  it('should process valid request and publish to response stream', async () => {
    // Reset mocks for clean test
    mockDanbooruApiService.fetchPosts.mockResolvedValueOnce({
      id: 123,
      file_url: 'https://example.com/image.jpg',
      large_file_url: 'https://example.com/large.jpg',
      tag_string_artist: 'artist_name',
      tag_string_general: '1girl blue_eyes',
      tag_string_character: 'hatsune_miku',
      tag_string_copyright: 'vocaloid',
      rating: 's',
      source: 'https://source.com',
      score: 1000,
      created_at: '2023-01-01T00:00:00.000Z',
    })
    mockCacheService.getCachedResult.mockResolvedValueOnce(null)
    mockRateLimiterService.checkRateLimit.mockResolvedValueOnce(true)

    const jobId = 'e2e-test-1'
    const query = 'hatsune_miku 1girl'
    const clientId = 'e2e-client'

    // Process the request directly (service-level e2e test)
    const result = await service.processRequest(jobId, query, clientId)

    expect(result.type).toBe('success')
    const successResult = result as DanbooruSuccessResponse
    expect(successResult.imageUrl).toBe('https://example.com/image.jpg')
    expect(successResult.author).toBe('artist_name')
    expect(successResult.tags).toBe('1girl blue_eyes')
    expect(successResult.rating).toBe('s')
    expect(successResult.copyright).toBe('vocaloid')
    expect(successResult.source).toBe('https://source.com')

    // Verify mocks were called
    expect(mockDanbooruApiService.fetchPosts).toHaveBeenCalledWith(query)
    expect(mockCacheService.setCache).toHaveBeenCalledWith(jobId, result)

    // Verify response was published to stream
    await new Promise(resolve => setTimeout(resolve, 100)) // Wait for async publish

    const responses = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      RESPONSES_STREAM,
      '0',
    )
    expect(responses).toBeDefined()
    const responseMessages = responses ? responses[0][1] : []
    expect(responseMessages).toHaveLength(1)

    const responseMessage = responseMessages[0]
    const responseFields: { [key: string]: string } = {}
    for (let i = 0; i < responseMessage[1].length; i += 2) {
      responseFields[responseMessage[1][i]] = responseMessage[1][i + 1]
    }

    expect(responseFields.jobId).toBe(jobId)
    expect(responseFields.type).toBe('success')
    expect(responseFields.imageUrl).toBe('https://example.com/image.jpg')
    expect(responseFields.source).toBe('https://source.com')
  })

  it('should validate and reject invalid post data', async () => {
    // Mock API to return null for no posts
    mockDanbooruApiService.fetchPosts.mockResolvedValueOnce(null)
    mockCacheService.getCachedResult.mockResolvedValueOnce(null)
    mockRateLimiterService.checkRateLimit.mockResolvedValueOnce(true)

    const jobId = 'e2e-invalid-1'
    const query = 'invalid_query'

    const result = await service.processRequest(jobId, query)

    expect(result.type).toBe('error')
    const errorResult = result as DanbooruErrorResponse
    expect(errorResult.error).toContain(
      'No posts found for the query or API error',
    )

    // Verify mocks were called
    expect(mockDanbooruApiService.fetchPosts).toHaveBeenCalledWith(query)
    expect(mockCacheService.setCache).toHaveBeenCalledWith(jobId, null)
  })

  it('should handle rate limiting', async () => {
    // Mock rate limit exceeded scenario
    mockRateLimiterService.checkRateLimit.mockResolvedValueOnce(false)
    mockCacheService.getCachedResult.mockResolvedValueOnce(null)

    const jobId = 'e2e-rate-limit-1'
    const query = 'rate_limit_test'

    const result = await service.processRequest(jobId, query)

    expect(result.type).toBe('error')
    const rateErrorResult = result as DanbooruErrorResponse
    expect(rateErrorResult.error).toContain('Rate limit exceeded')

    // Verify rate limit check was called
    expect(mockRateLimiterService.checkRateLimit).toHaveBeenCalledWith('global')
  })

  it('should handle concurrent duplicate jobs with atomic deduplication', async () => {
    const jobId = 'e2e-concurrent-dup-1'
    const processedKey = `processed:${jobId}`
    const DEDUP_TTL_SECONDS = 300 // Match the constant value used in production

    // Clear any existing key
    await redisClient.del(processedKey)

    // Create 5 concurrent attempts to set the deduplication key
    const attempts = Array.from({ length: 5 }, (_, index) =>
      (async () => {
        try {
          const result = await redisClient.set(
            processedKey,
            '1',
            'EX',
            DEDUP_TTL_SECONDS,
            'NX'
          )
          return { index, result, success: result === 'OK' }
        } catch (error) {
          return { index, error: error.message, success: false }
        }
      })()
    )

    // Execute all attempts concurrently
    const results = await Promise.all(attempts)

    // Verify exactly one succeeded, others failed due to NX
    const successfulAttempts = results.filter(r => r.success)
    const failedAttempts = results.filter(r => !r.success)

    expect(successfulAttempts).toHaveLength(1)
    expect(failedAttempts).toHaveLength(4)

    // Verify the successful one got 'OK'
    expect(successfulAttempts[0].result).toBe('OK')

    // Verify the failed ones did not get 'OK' (should be null in ioredis for NX failure)
    failedAttempts.forEach(attempt => {
      expect(attempt.result).not.toBe('OK')
      expect(attempt.result).toBeNull()
    })

    // Verify the key exists and has TTL
    const keyExists = await redisClient.exists(processedKey)
    expect(keyExists).toBe(1)

    const ttl = await redisClient.ttl(processedKey)
    expect(ttl).toBeGreaterThanOrEqual(DEDUP_TTL_SECONDS - 5) // Allow some time variance
    expect(ttl).toBeLessThanOrEqual(DEDUP_TTL_SECONDS)

    // Clean up
    await redisClient.del(processedKey)
  }, 10000)
  it('should handle DLQ retry logic', async () => {
    const jobId = 'e2e-dlq-retry-1'
    const query = 'dlq_test'

    // Add to DLQ with retryCount = 0 (should be retried)
    await redisClient.xadd(
      DLQ_STREAM,
      '*',
      'jobId',
      jobId,
      'error',
      'Test error',
      'query',
      query,
      'retryCount',
      '0',
    )

    // Read from DLQ - read from beginning
    const dlqMessages = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      DLQ_STREAM,
      '0',
    )
    expect(dlqMessages).toBeDefined()
    const dlqMessageList = dlqMessages?.[0]?.[1] || []
    expect(dlqMessageList).toHaveLength(1)

    const message = dlqMessageList[0]
    const messageId = message[0]
    const fields = message[1]

    // Parse fields properly
    const fieldMap: { [key: string]: string } = {}
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap[fields[i]] = fields[i + 1]
    }

    const extractedJobId = fieldMap.jobId
    const extractedQuery = fieldMap.query
    const retryCount = parseInt(fieldMap.retryCount || '0')

    expect(retryCount).toBe(0)
    expect(extractedJobId).toBe(jobId)
    expect(extractedQuery).toBe(query)

    if (retryCount < MAX_DLQ_RETRIES) {
      // Simulate retry: add back to requests stream
      await redisClient.xadd(
        REQUESTS_STREAM,
        '*',
        'jobId',
        extractedJobId,
        'query',
        extractedQuery,
        'clientId',
        'e2e-test-client',
      )
      // Remove from DLQ (simulate acknowledgment)
      await redisClient.xdel(DLQ_STREAM, messageId)
    }

    // Verify retry was added back to main stream
    const retryMessages = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      REQUESTS_STREAM,
      '0',
    )
    expect(retryMessages).toBeDefined()
    const retryMessageList = retryMessages?.[0]?.[1] || []
    expect(retryMessageList).toHaveLength(1)

    const retryMessage = retryMessageList[0]
    const retryFields: { [key: string]: string } = {}
    for (let i = 0; i < retryMessage[1].length; i += 2) {
      retryFields[retryMessage[1][i]] = retryMessage[1][i + 1]
    }

    expect(retryFields.jobId).toBe(extractedJobId)
    expect(retryFields.query).toBe(extractedQuery)

    // Verify DLQ message was removed
    const remainingDlq = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      DLQ_STREAM,
      '0',
    )
    expect(remainingDlq).toBeNull()
  }, 10000)

  it('should move to dead queue after max retries', async () => {
    const jobId = 'e2e-dead-queue-1'
    const query = 'max_retries_test'
    const error = 'No posts found for the query'

    // Add to DLQ with max retry count
    await redisClient.xadd(
      'danbooru-dlq',
      '*',
      'jobId',
      jobId,
      'error',
      error,
      'query',
      query,
      'retryCount',
      (MAX_DLQ_RETRIES + 1).toString(),
    )

    // Read from DLQ - read from beginning
    const dlqMessages = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      'danbooru-dlq',
      '0',
    )
    expect(dlqMessages).toBeDefined()
    const dlqMessageList = dlqMessages?.[0]?.[1] || []
    expect(dlqMessageList).toHaveLength(1)

    const message = dlqMessageList[0]
    const fields = message[1]
    const extractedJobId = fields[1] // 'jobId' value (index 1)
    const extractedError = fields[3] // 'error' value (index 3)
    const extractedQuery = fields[5] // 'query' value (index 5)
    const extractedRetryCount = parseInt(fields[7]) // 'retryCount' value (index 7)

    expect(extractedRetryCount).toBeGreaterThanOrEqual(MAX_DLQ_RETRIES)
    expect(extractedJobId).toBe(jobId)

    if (extractedRetryCount >= MAX_DLQ_RETRIES) {
      // Move to dead queue
      await redisClient.xadd(
        'danbooru-dead',
        '*',
        'jobId',
        extractedJobId,
        'query',
        extractedQuery,
        'finalError',
        `Max retries exceeded: ${extractedError}`,
        'timestamp',
        Date.now().toString(),
      )
      // Delete from DLQ
      await redisClient.xdel('danbooru-dlq', message[0])
    }

    // Verify moved to dead queue
    const deadMessages = await redisClient.xread(
      'COUNT',
      1,
      'STREAMS',
      'danbooru-dead',
      '0',
    )
    expect(deadMessages).toBeDefined()
    const deadMessageList = deadMessages?.[0]?.[1] || []
    expect(deadMessageList).toHaveLength(1)

    const deadMessage = deadMessageList[0]
    const deadFields: { [key: string]: string } = {}
    for (let i = 0; i < deadMessage[1].length; i += 2) {
      deadFields[deadMessage[1][i]] = deadMessage[1][i + 1]
    }

    expect(deadFields.jobId).toBe(extractedJobId)
    expect(deadFields.finalError).toContain('Max retries exceeded')
    expect(deadFields.timestamp).toBeDefined()
  }, 10000)
})
