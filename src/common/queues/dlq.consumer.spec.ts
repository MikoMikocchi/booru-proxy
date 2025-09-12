import { Test, TestingModule } from '@nestjs/testing'
import { DlqConsumer } from './dlq.consumer'
import Redis from 'ioredis'
import RedisMock from 'ioredis-mock'
import * as dlqUtil from './utils/dlq.util'
import {
  MAX_DLQ_RETRIES,
  DEDUP_TTL_SECONDS,
  QUERY_LOCK_TIMEOUT_SECONDS,
} from '../constants'
import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { Job } from 'bullmq'

jest.mock('./utils/dlq.util')
jest.mock('bullmq')

const mockRetryFromDLQ = dlqUtil.retryFromDLQ as jest.Mock
const mockMoveToDeadQueue = dlqUtil.moveToDeadQueue as jest.Mock
const mockDedupCheck = dlqUtil.dedupCheck as jest.Mock
const mockAddToDLQ = dlqUtil.addToDLQ as jest.Mock
const mockJob = jest.fn()

describe('DlqConsumer', () => {
  let consumer: DlqConsumer
  let mockRedis: any
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    jest.resetModules()

    mockRedis = new RedisMock()
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any

    // Configure utility mocks
    mockRetryFromDLQ.mockImplementation(
      async (redis, apiPrefix, jobId, query, retryCount, streamId) => {
        if (redis === mockRedis) {
          // Simulate xadd to REQUESTS_STREAM
          const requestsStream = `${apiPrefix}:requests`
          await redis.xadd(
            requestsStream,
            '*',
            'jobId',
            jobId,
            'query',
            query,
            'retryCount',
            (retryCount + 1).toString(),
          )
          return { success: true }
        }
        return { success: false }
      },
    )

    mockMoveToDeadQueue.mockImplementation(
      (redis, apiPrefix, jobId, error, queryHash, originalError) => {
        if (redis === mockRedis) {
          return Promise.resolve()
        }
      },
    )

    mockDedupCheck.mockImplementation(
      async (redis, apiPrefix, query, jobId) => {
        if (redis === mockRedis) {
          const queryHash = crypto.createHash('md5').update(query).digest('hex')
          const dedupKey = `dedup:${apiPrefix}:${queryHash}`

          // Simulate XRANGE check for recent duplicates with actual query comparison
          const recentDuplicates = await redis.xrange(
            `${apiPrefix}:requests`,
            '-',
            '+',
            'COUNT',
            100,
          )
          const hasRecentDuplicate = recentDuplicates.some((entry: any) =>
            entry[1].some(
              (field: any) =>
                field[0] === 'query' &&
                field[1] === query, // Compare actual query, not hash
            ),
          )

          if (hasRecentDuplicate) {
            return true
          }

          // Query locking with SET NX
          const lockResult = await redis.set(
            dedupKey,
            jobId,
            'EX',
            DEDUP_TTL_SECONDS,
            'NX',
          )
          if (lockResult === 'OK') {
            await redis.del(dedupKey) // Clean up after check
            return false // No duplicate
          }

          return true // Lock exists, duplicate detected
        }
        return false
      },
    )

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DlqConsumer,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: Logger, useValue: mockLogger },
      ],
    }).compile()

    consumer = module.get<DlqConsumer>(DlqConsumer)
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.clearAllMocks()
    mockRedis.flushall()
  })

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      const startProcessingSpy = jest.spyOn(consumer as any, 'startProcessing')
      const loggerSpy = jest.spyOn(mockLogger, 'log')

      await consumer.onModuleInit()

      expect(loggerSpy).toHaveBeenCalledWith(
        'Starting DLQ stream processor for all APIs',
      )
      expect(startProcessingSpy).toHaveBeenCalled()
    })
  })

  describe('processDLQ', () => {
    const apiName = 'danbooru'
    const dlqStream = `${apiName}-dlq`

    beforeEach(() => {
      mockRetryFromDLQ.mockResolvedValue({ success: true })
      mockMoveToDeadQueue.mockResolvedValue(undefined)
    })

    it('should return when no entries in stream', async () => {
      mockRedis.xread.mockResolvedValue(null)

      await consumer['processDLQ'](apiName)

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK',
        5000,
        'STREAMS',
        dlqStream,
        '>',
        'COUNT',
        10,
      )
    })

    it('should process valid retryable DLQ entry and move to dead queue due to privacy', async () => {
      const streamId = '1640995200000-0'
      const queryHash = 'hash:abc123'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'test-job-123'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalError', 'API returned empty'],
              ['queryLength', '15'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Processing DLQ entry test-job-123 (${apiName}): error = No posts found, query hash = ${queryHash}, length = 15 chars, retry = 0/${MAX_DLQ_RETRIES}`,
        ),
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipping retry for job test-job-123 (danbooru) - original query not available due to privacy masking',
        ),
      )
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'test-job-123',
        'No posts found',
        queryHash,
        'API returned empty',
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should retry job by adding back to REQUESTS_STREAM when under max retries', async () => {
      const streamId = '1640995200000-0'
      const originalQuery = 'cat rating:safe limit:10'
      const queryHash = crypto
        .createHash('md5')
        .update(originalQuery)
        .digest('hex')
      const requestsStream = `${apiName}:requests`

      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'retry-test-job'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalQuery', originalQuery],
              ['queryLength', originalQuery.length.toString()],
              ['originalError', 'Empty response'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)
      mockRetryFromDLQ.mockResolvedValue({ success: true })

      // Mock to bypass privacy check for test
      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(true)
      jest.spyOn(consumer as any, 'privacyCheck').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Retrying job retry-test-job from DLQ to main stream (danbooru, attempt 1)',
        ),
      )
      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'retry-test-job',
        originalQuery,
        0,
        streamId,
      )
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Successfully retried job retry-test-job, removed from DLQ',
        ),
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should handle validation error during retry and keep in DLQ', async () => {
      const streamId = '1640995200000-0'
      const originalQuery = 'invalid::query' // Invalid format
      const queryHash = crypto
        .createHash('md5')
        .update(originalQuery)
        .digest('hex')

      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'validation-error-job'],
              ['error', 'Validation failed'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalQuery', originalQuery],
              ['queryLength', originalQuery.length.toString()],
            ],
          ],
        ],
      ] as any

      mockRetryFromDLQ.mockRejectedValue({
        success: false,
        error: 'Validation failed for retry',
      })
      mockRedis.xread.mockResolvedValue(mockXReadResult)

      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(true)
      jest.spyOn(consumer as any, 'privacyCheck').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to retry job validation-error-job: Validation failed for retry',
        ),
      )
      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'validation-error-job',
        originalQuery,
        0,
        streamId,
      )
      // Should NOT delete from DLQ since retry failed
      expect(mockRedis.xdel).not.toHaveBeenCalled()
    })

    it('should handle max retries and move to dead queue', async () => {
      const streamId = '1640995200000-0'
      const queryHash = 'hash:ghi789'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'max-retry-job'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', `${MAX_DLQ_RETRIES}`],
              ['originalError', 'Max retries reached'],
              ['queryLength', '25'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'max-retry-job',
        'No posts found',
        queryHash,
        'Max retries reached',
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Job max-retry-job moved to dead queue (danbooru, max retries or permanent error)',
        ),
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should handle non-retryable errors and move to dead queue', async () => {
      const streamId = '1640995200000-0'
      const queryHash = 'hash:jkl012'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'non-retry-job'],
              ['error', 'Invalid authentication'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalError', 'Auth failed'],
              ['queryLength', '18'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'non-retry-job',
        'Invalid authentication',
        queryHash,
        'Auth failed',
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should handle invalid DLQ entries and delete them', async () => {
      const streamId = '1640995200000-0'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              // Missing jobId field
              ['error', 'Some error'],
              ['query', 'hash:mno345'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Invalid DLQ entry 1640995200000-0 for danbooru, deleting',
        ),
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
      expect(mockMoveToDeadQueue).not.toHaveBeenCalled()
    })

    it('should process multiple DLQ entries in single batch', async () => {
      const streamId1 = '1640995200000-0'
      const streamId2 = '1640995200001-0'
      const queryHash1 = 'hash:job1'
      const queryHash2 = 'hash:job2'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId1,
              ['jobId', 'job1'],
              ['error', 'No posts found'],
              ['query', queryHash1],
              ['retryCount', '0'],
              ['queryLength', '10'],
            ],
            [
              streamId2,
              ['jobId', 'job2'],
              ['error', 'Rate limit'],
              ['query', queryHash2],
              ['retryCount', '0'],
              ['queryLength', '12'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledTimes(2)
      expect(mockRedis.xdel).toHaveBeenCalledTimes(2)
      expect(mockLogger.error).toHaveBeenCalledTimes(2)
      expect(mockMoveToDeadQueue).toHaveBeenNthCalledWith(
        1,
        mockRedis,
        apiName,
        'job1',
        'No posts found',
        queryHash1,
        expect.any(String),
      )
      expect(mockMoveToDeadQueue).toHaveBeenNthCalledWith(
        2,
        mockRedis,
        apiName,
        'job2',
        'Rate limit',
        queryHash2,
        expect.any(String),
      )
    })

    it('should handle privacy masked entries without original query', async () => {
      const streamId = '1640995200000-0'
      const queryHash = 'hash:privacy123'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'privacy-job'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['queryLength', '15'],
              // Missing 'originalQuery' field due to privacy masking
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Processing DLQ entry privacy-job (${apiName}): error = No posts found, query hash = ${queryHash}, length = 15 chars, retry = 0/${MAX_DLQ_RETRIES}`,
        ),
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipping retry for job privacy-job (danbooru) - original query not available due to privacy masking',
        ),
      )
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'privacy-job',
        'No posts found',
        queryHash,
        expect.any(String),
      )
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
      expect(mockRetryFromDLQ).not.toHaveBeenCalled()
    })

    it('should handle Redis xread connection errors gracefully', async () => {
      const redisError = new Error('Connection lost')
      mockRedis.xread.mockRejectedValue(redisError)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `DLQ processing error for ${apiName}: Connection lost`,
        ),
      )
      expect(mockMoveToDeadQueue).not.toHaveBeenCalled()
      expect(mockRedis.xdel).not.toHaveBeenCalled()
    })

    it('should handle xdel failures without stopping processing other entries', async () => {
      const streamId1 = '1640995200000-0'
      const streamId2 = '1640995200001-0'
      const queryHash1 = 'hash:fail1'
      const queryHash2 = 'hash:success2'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId1,
              ['jobId', 'xdel-fail-job'],
              ['error', 'Test error'],
              ['query', queryHash1],
              ['retryCount', '0'],
              ['queryLength', '15'],
            ],
            [
              streamId2,
              ['jobId', 'success-job'],
              ['error', 'No posts found'],
              ['query', queryHash2],
              ['retryCount', '0'],
              ['queryLength', '20'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel
        .mockRejectedValueOnce(new Error('XDEL failed for first entry'))
        .mockResolvedValueOnce(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'DLQ processing error for danbooru: XDEL failed for first entry',
        ),
      )
      // Should still process second entry
      expect(mockMoveToDeadQueue).toHaveBeenCalledTimes(1) // Only second entry
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'success-job',
        'No posts found',
        queryHash2,
        expect.any(String),
      )
      // First entry xdel failed but second succeeded
      expect(mockRedis.xdel).toHaveBeenCalledTimes(2)
    })
  })
})
