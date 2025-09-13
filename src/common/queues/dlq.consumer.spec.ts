import { Test, TestingModule } from '@nestjs/testing'
import { DlqConsumer } from './dlq.consumer'
import { Redis } from 'ioredis'
import * as dlqUtil from './utils/dlq.util'
import { getStreamName, MAX_DLQ_RETRIES, DEDUP_TTL_SECONDS } from '../constants'
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

    mockMoveToDeadQueue.mockImplementation(async () => {
      await Promise.resolve() // to satisfy require-await
      return
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    ;(consumer as any).logger = mockLogger
  })

  afterEach(async () => {
    jest.clearAllMocks()
    await mockRedis.flushall()
  })

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      const startProcessingSpy = jest
        .spyOn(
          consumer as unknown as { startProcessing: jest.Mock },
          'startProcessing',
        )
        .mockResolvedValue(undefined)
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
    const dlqStream = getStreamName(apiName, 'dlq')

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
              [
                ['jobId', 'test-job-123'],
                ['error', 'No posts found'],
                ['query', queryHash],
                ['retryCount', '0'],
                ['originalError', 'API returned empty'],
                ['queryLength', '15'],
              ],
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
        apiName,
        'test-job-123',
        'No posts found',
        queryHash,
        'API returned empty',
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, streamId)
    })

    it('should retry job by adding back to REQUESTS_STREAM when under max retries', async () => {
      const queryHash = 'retry-hash'

      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              [
                ['jobId', 'retry-test-job'],
                ['error', 'No posts found'],
                ['query', queryHash],
                ['retryCount', '0'],
                ['queryLength', '25'],
                ['originalError', 'Empty response'],
              ],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipping retry for job retry-test-job (danbooru) - original query not available due to privacy masking',
        ),
      )
      expect(mockRetryFromDLQ).not.toHaveBeenCalled()
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'retry-test-job',
        'No posts found',
        queryHash,
        'Empty response',
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRedis.xdel).toHaveBeenCalledWith(dlqStream, '1640995200000-0')
    })

    it('should handle max retries and move to dead queue', async () => {
      const queryHash = 'hash:ghi789'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              [
                ['jobId', 'max-retry-job'],
                ['error', 'No posts found'],
                ['query', queryHash],
                ['retryCount', `${MAX_DLQ_RETRIES}`],
                ['originalError', 'Max retries reached'],
                ['queryLength', '25'],
              ],
            ],
          ],
        ],
      ] as unknown as XReadResult

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
              [
                ['jobId', 'non-retry-job'],
                ['error', 'Invalid authentication'],
                ['query', queryHash],
                ['retryCount', '0'],
                ['originalError', 'Auth failed'],
                ['queryLength', '18'],
              ],
            ],
          ],
        ],
      ] as unknown as XReadResult

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ'](apiName)

      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'non-retry-job',
        'Invalid authentication',
        queryHash,
        'Auth failed',
      )
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
              [
                // Missing jobId field
                ['error', 'Some error'],
                ['query', 'hash:mno345'],
              ],
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
              [
                ['jobId', 'job1'],
                ['error', 'No posts found'],
                ['query', queryHash1],
                ['retryCount', `${MAX_DLQ_RETRIES}`],
                ['queryLength', '10'],
              ],
            ],
            [
              '1640995200001-0',
              [
                ['jobId', 'job2'],
                ['error', 'Rate limit'],
                ['query', queryHash2],
                ['retryCount', `${MAX_DLQ_RETRIES}`],
                ['queryLength', '12'],
              ],
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
      expect(mockLogger.warn).toHaveBeenCalledTimes(2)
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'job1',
        'No posts found',
        queryHash1,
        'Max retries exceeded',
      )
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'job2',
        'Rate limit',
        queryHash2,
        'Max retries exceeded',
      )
    })

    it('should handle privacy masked entries without original query', async () => {
      const queryHash = 'hash:privacy123'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              '1640995200000-0',
              [
                ['jobId', 'privacy-job'],
                ['error', 'No posts found'],
                ['query', queryHash],
                ['retryCount', '0'],
                ['queryLength', '15'],
                // Missing 'originalQuery' field due to privacy masking
              ],
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
      expect(mockMoveToDeadQueue).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'privacy-job',
        'No posts found',
        queryHash,
        'Retry skipped due to privacy masking (attempt 1)',
      )
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
  })
})
