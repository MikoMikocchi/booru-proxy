import { Test, TestingModule } from '@nestjs/testing'
import { DlqConsumer } from './dlq.consumer'
import { Redis } from 'ioredis'
import * as dlqUtil from './utils/dlq.util'
import { MAX_DLQ_RETRIES, DEDUP_TTL_SECONDS } from '../constants'
import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'

jest.mock('./utils/dlq.util')

const mockRetryFromDLQ = dlqUtil.retryFromDLQ as jest.Mock
const mockMoveToDeadQueue = dlqUtil.moveToDeadQueue as jest.Mock
const mockDedupCheck = dlqUtil.dedupCheck as jest.Mock

type XRangeEntry = [string, string[]]
type XRangeResult = XRangeEntry[]
type XReadResult = [string, XRangeResult][] | null

describe('DlqConsumer', () => {
  let consumer: DlqConsumer
  let mockRedis: jest.Mocked<Redis>
  let mockLogger: Partial<jest.Mocked<Logger>>

  beforeEach(async () => {
    jest.resetModules()

    mockRedis = {
      xadd: jest.fn(),
      xrange: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      xread: jest.fn(),
      xdel: jest.fn(),
      flushall: jest.fn(),
    } as unknown as jest.Mocked<Redis>

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    }

    // Configure utility mocks
    mockRetryFromDLQ.mockImplementation(async redis => {
      await Promise.resolve() // to satisfy require-await
      if (redis === mockRedis) {
        return { success: true }
      }
      return { success: false }
    })

    mockMoveToDeadQueue.mockImplementation(async redis => {
      await Promise.resolve() // to satisfy require-await
      if (redis === mockRedis) {
        return
      }
    })

    mockDedupCheck.mockImplementation(async (redis, query) => {
      await Promise.resolve() // to satisfy require-await
      if (redis === mockRedis) {
        const queryHash = crypto
          .createHash('md5')
          .update(query as string)
          .digest('hex')
        const dedupKey = `dedup:danbooru:${queryHash}`

        const recentDuplicates = (await mockRedis.xrange(
          `danbooru:requests`,
          '-',
          '+',
          'COUNT',
          100,
        )) as XRangeResult
        const hasRecentDuplicate = recentDuplicates.some(entry => {
          const fields = entry[1]
          const queryIndex = fields.indexOf('query')
          return (
            queryIndex !== -1 &&
            queryIndex + 1 < fields.length &&
            fields[queryIndex + 1] === query
          )
        })

        if (hasRecentDuplicate) {
          return true
        }

        const lockResult: string | null = await mockRedis.set(
          dedupKey,
          'jobId',
          'EX',
          DEDUP_TTL_SECONDS,
          'NX',
        )
        if (lockResult === 'OK') {
          await mockRedis.del(dedupKey)
          return false
        }

        return true
      }
      return false
    })

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

  afterEach(async () => {
    jest.clearAllMocks()
    await mockRedis.flushall()
  })

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      // eslint-disable-next-line @typescript-eslint/unbound-method
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
      ] as unknown as XReadResult

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
        queryHash,
        'API returned empty',
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should retry job by adding back to REQUESTS_STREAM when under max retries', async () => {
      const originalQuery = 'cat rating:safe limit:10'
      const queryHash = crypto
        .createHash('md5')
        .update(originalQuery)
        .digest('hex')

      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
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
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)
      mockRetryFromDLQ.mockResolvedValue({ success: true })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(consumer as any, 'privacyCheck').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Retrying job retry-test-job from DLQ to main stream (danbooru, attempt 1)',
        ),
      )
      expect(mockRetryFromDLQ).toHaveBeenCalledWith(mockRedis, originalQuery, 0)
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Successfully retried job retry-test-job, removed from DLQ',
        ),
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
    })

    it('should handle validation error during retry and keep in DLQ', async () => {
      const originalQuery = 'invalid::query'
      const queryHash = crypto
        .createHash('md5')
        .update(originalQuery)
        .digest('hex')

      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'validation-error-job'],
              ['error', 'Validation failed'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalQuery', originalQuery],
              ['queryLength', originalQuery.length.toString()],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRetryFromDLQ.mockRejectedValue({
        success: false,
        error: 'Validation failed for retry',
      })
      mockRedis.xread.mockResolvedValue(mockXReadResult)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(consumer as any, 'privacyCheck').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to retry job validation-error-job: Validation failed for retry',
        ),
      )
      expect(mockRetryFromDLQ).toHaveBeenCalledWith(mockRedis, originalQuery, 0)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).not.toHaveBeenCalled()
    })

    it('should handle max retries and move to dead queue', async () => {
      const queryHash = 'hash:ghi789'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'max-retry-job'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', `${MAX_DLQ_RETRIES}`],
              ['originalError', 'Max retries reached'],
              ['queryLength', '25'],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Job max-retry-job moved to dead queue (danbooru, max retries or permanent error)',
        ),
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
    })

    it('should handle non-retryable errors and move to dead queue', async () => {
      const queryHash = 'hash:jkl012'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'non-retry-job'],
              ['error', 'Invalid authentication'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['originalError', 'Auth failed'],
              ['queryLength', '18'],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(consumer as any, 'isRetryableError').mockReturnValue(false)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
    })

    it('should handle invalid DLQ entries and delete them', async () => {
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              // Missing jobId field
              ['error', 'Some error'],
              ['query', 'hash:mno345'],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Invalid DLQ entry 1640995200000-0 for danbooru, deleting',
        ),
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
      expect(mockMoveToDeadQueue).not.toHaveBeenCalled()
    })

    it('should process multiple DLQ entries in single batch', async () => {
      const queryHash1 = 'hash:job1'
      const queryHash2 = 'hash:job2'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'job1'],
              ['error', 'No posts found'],
              ['query', queryHash1],
              ['retryCount', '0'],
              ['queryLength', '10'],
            ],
            [
              '1640995200001-0',
              ['jobId', 'job2'],
              ['error', 'Rate limit'],
              ['query', queryHash2],
              ['retryCount', '0'],
              ['queryLength', '12'],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledTimes(2)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledTimes(2)
      expect(mockLogger.error).toHaveBeenCalledTimes(2)
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash1)
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash2)
    })

    it('should handle privacy masked entries without original query', async () => {
      const queryHash = 'hash:privacy123'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'privacy-job'],
              ['error', 'No posts found'],
              ['query', queryHash],
              ['retryCount', '0'],
              ['queryLength', '15'],
              // Missing 'originalQuery' field due to privacy masking
            ],
          ],
        ],
      ] as unknown as XReadResult

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
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
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
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).not.toHaveBeenCalled()
    })

    it('should handle xdel failures without stopping processing other entries', async () => {
      const queryHash1 = 'hash:fail1'
      const queryHash2 = 'hash:success2'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              ['jobId', 'xdel-fail-job'],
              ['error', 'Test error'],
              ['query', queryHash1],
              ['retryCount', '0'],
              ['queryLength', '15'],
            ],
            [
              '1640995200001-0',
              ['jobId', 'success-job'],
              ['error', 'No posts found'],
              ['query', queryHash2],
              ['retryCount', '0'],
              ['queryLength', '20'],
            ],
          ],
        ],
      ] as unknown as XReadResult

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
      expect(mockMoveToDeadQueue).toHaveBeenCalledTimes(1)
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(mockRedis, queryHash2)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledTimes(2)
    })
  })
})
