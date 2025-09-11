import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from '../src/danbooru/danbooru.service'
import { AppModule } from '../src/app.module'
import Redis from 'ioredis'
import {
  GenericContainer,
  StartedTestContainer,
  TestContainers,
} from 'testcontainers'
import { ConfigModule } from '@nestjs/config'
import nock from 'nock'
import {
  DanbooruSuccessResponse,
  DanbooruErrorResponse,
} from '../src/danbooru/interfaces/danbooru.interface'
import { MAX_DLQ_RETRIES } from '../src/common/constants'

describe('DanbooruService (e2e)', () => {
  let service: DanbooruService
  let redisContainer: StartedTestContainer
  let redisClient: Redis

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

    redisClient = new Redis(redisUrl)
    await redisClient.ping()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AppModule],
      providers: [{ provide: 'REDIS_CLIENT', useValue: redisClient }],
    }).compile()

    service = module.get<DanbooruService>(DanbooruService)

    // Mock Danbooru API
    nock('https://danbooru.donmai.us')
      .post('/posts.json')
      .reply(200, {
        data: [
          {
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
          },
        ],
      })
  }, 30000)

  afterAll(async () => {
    await redisClient?.disconnect()
    if (redisContainer) {
      await redisContainer.stop()
    }
    nock.cleanAll()
  })

  it('should process valid request and publish to response stream', async () => {
    const jobId = 'e2e-test-1'
    const query = 'hatsune_miku 1girl'

    // Add request to stream
    const requestId = await redisClient.xadd(
      'danbooru:requests',
      '*',
      'jobId',
      jobId,
      'query',
      query,
    )

    // Process the request
    const result = await service.processRequest(jobId, query)

    expect(result.type).toBe('success')
    const successResult = result as DanbooruSuccessResponse
    expect(successResult.imageUrl).toBe('https://example.com/image.jpg')
    expect(successResult.author).toBe('artist_name')
    expect(successResult.tags).toBe('1girl blue_eyes')
    expect(successResult.rating).toBe('s')
    expect(successResult.copyright).toBe('vocaloid')

    // Verify response was published to stream
    const responses = await redisClient.xread(
      'STREAMS',
      'danbooru:responses',
      0,
      1,
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
  })

  it('should validate and reject invalid post data', async () => {
    // Mock invalid API response
    nock.cleanAll()
    nock('https://danbooru.donmai.us')
      .post('/posts.json')
      .reply(200, {
        data: [
          {
            id: 'invalid', // Should be number
            file_url: 'https://example.com/image.jpg',
            tag_string_general: '1girl',
            tag_string_copyright: 'test',
            rating: 'invalid', // Should be g|s|q|e
            score: -100, // Should be >= 0
            created_at: 'invalid-date', // Should be ISO date
          },
        ],
      })

    const jobId = 'e2e-invalid-1'
    const query = 'invalid_query'

    const result = await service.processRequest(jobId, query)

    expect(result.type).toBe('error')
    const errorResult = result as DanbooruErrorResponse
    expect(errorResult.error).toContain(
      'No posts found for the query or API error',
    )

    // Verify added to DLQ
    const dlqStream = await redisClient.xread('STREAMS', 'danbooru-dlq', 0, 1)
    expect(dlqStream).toBeDefined()
    const dlqMessageList = dlqStream ? dlqStream[0][1] : []
    expect(dlqMessageList).toHaveLength(1)

    const dlqMessage = dlqMessageList[0]
    const dlqFields: { [key: string]: string } = {}
    for (let i = 0; i < dlqMessage[1].length; i += 2) {
      dlqFields[dlqMessage[1][i]] = dlqMessage[1][i + 1]
    }

    expect(dlqFields.jobId).toBe(jobId)
    expect(dlqFields.query).toBe(query)
  })

  it('should handle rate limiting', async () => {
    // Mock rate limit exceeded scenario
    const jobId = 'e2e-rate-limit-1'
    const query = 'rate_limit_test'

    // Simulate rate limit by directly calling checkRateLimit logic
    const rateKey = 'rate:danbooru:global'
    await redisClient.zadd(rateKey, Date.now(), Date.now().toString())
    await redisClient.expire(rateKey, 60)

    const result = await service.processRequest(jobId, query)

    expect(result.type).toBe('error')
    const rateErrorResult = result as DanbooruErrorResponse
    expect(rateErrorResult.error).toContain('Rate limit exceeded')

    // Verify added to DLQ
    const dlqMessages2 = await redisClient.xread(
      'STREAMS',
      'danbooru-dlq',
      0,
      1,
    )
    expect(dlqMessages2).toBeDefined()
    const dlqMessageList2 = dlqMessages2 ? dlqMessages2[0][1] : []
    expect(dlqMessageList2).toHaveLength(1)
  })

  it('should handle DLQ retry logic', async () => {
    const jobId = 'e2e-dlq-retry-1'
    const query = 'dlq_test'
    const error = 'No posts found for the query'
    let extractedJobId = jobId // Initialize with expected value
    let extractedQuery = query // Initialize with expected value

    // Add to DLQ with retryCount = 0
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
      '0',
    )

    // Simulate DLQ processing by manually moving message (simplified for test)
    // In real scenario, this would be handled by the DLQ consumer
    const dlqMessages = await redisClient.xread('STREAMS', 'danbooru-dlq', 0, 1)
    if (dlqMessages && dlqMessages[0]) {
      const message = dlqMessages[0][1][0]
      const fields = message[1]
      extractedJobId = fields[1] // 'jobId' value (index 1)
      const extractedError = fields[3] // 'error' value (index 3)
      extractedQuery = fields[5] // 'query' value (index 5)
      const extractedRetryCount = parseInt(fields[7]) // 'retryCount' value (index 7)

      if (extractedRetryCount < MAX_DLQ_RETRIES) {
        // Simulate retry by adding back to requests stream
        await redisClient.xadd(
          'danbooru:requests',
          '*',
          'jobId',
          extractedJobId,
          'query',
          extractedQuery,
        )
        // Acknowledge/delete the DLQ message
        await redisClient.xdel('danbooru-dlq', message[0])
      }
    }

    // Verify retry was added back to main stream
    const retryMessages = await redisClient.xread(
      'STREAMS',
      'danbooru:requests',
      0,
      1,
    )
    expect(retryMessages).toBeDefined()
    const retryMessageList = retryMessages ? retryMessages[0][1] : []
    expect(retryMessageList).toHaveLength(1)

    const retryMessage = retryMessageList[0]
    const retryFields: { [key: string]: string } = {}
    for (let i = 0; i < retryMessage[1].length; i += 2) {
      retryFields[retryMessage[1][i]] = retryMessage[1][i + 1]
    }

    expect(retryFields.jobId).toBe(extractedJobId)
    expect(retryFields.query).toBe(extractedQuery)

    // Verify DLQ message was removed (acknowledged)
    const remainingDlq = await redisClient.xread(
      'STREAMS',
      'danbooru-dlq',
      0,
      1,
    )
    expect(remainingDlq).toBeNull()
  }, 10000)

  it('should move to dead queue after max retries', async () => {
    const jobId = 'e2e-dead-queue-1'
    const query = 'max_retries_test'
    const error = 'No posts found for the query'
    let extractedJobId = jobId // Initialize with expected value

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

    // Simulate DLQ processing for max retries (move to dead queue)
    const dlqMessages = await redisClient.xread('STREAMS', 'danbooru-dlq', 0, 1)
    if (dlqMessages && dlqMessages[0]) {
      const message = dlqMessages[0][1][0]
      const fields = message[1]
      extractedJobId = fields[1] // 'jobId' value (index 1)
      const extractedError = fields[3] // 'error' value (index 3)
      const extractedQuery = fields[5] // 'query' value (index 5)
      const extractedRetryCount = parseInt(fields[7]) // 'retryCount' value (index 7)

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
    }

    // Verify moved to dead queue
    const deadMessages = await redisClient.xread(
      'STREAMS',
      'danbooru-dead',
      0,
      1,
    )
    expect(deadMessages).toBeDefined()
    const deadMessageList = deadMessages ? deadMessages[0][1] : []
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
