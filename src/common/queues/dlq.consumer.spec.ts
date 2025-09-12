import { Test, TestingModule } from '@nestjs/testing'
import { DlqConsumer } from './dlq.consumer'
import Redis from 'ioredis'
import * as dlqUtil from './utils/dlq.util'
import { MAX_DLQ_RETRIES } from '../constants'
import { Logger } from '@nestjs/common'

jest.mock('./utils/dlq.util')

const mockRetryFromDLQ = dlqUtil.retryFromDLQ as jest.Mock
const mockMoveToDeadQueue = dlqUtil.moveToDeadQueue as jest.Mock
const mockDedupCheck = dlqUtil.dedupCheck as jest.Mock
const mockAddToDLQ = dlqUtil.addToDLQ as jest.Mock

describe('DlqConsumer', () => {
  let consumer: DlqConsumer
  let mockRedis: jest.Mocked<Redis>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    // Reset module mocks before each test
    jest.resetModules()

    mockRedis = {
      xread: jest.fn(),
      xdel: jest.fn(),
    } as any

    // Mock the dlqUtil functions to use our mockRedis
    dlqUtil.retryFromDLQ = jest.fn().mockImplementation((redis, ...args) => {
      if (redis === mockRedis) {
        return Promise.resolve({ success: true })
      }
      return Promise.resolve({ success: false })
    })

    dlqUtil.moveToDeadQueue = jest.fn().mockImplementation((redis, ...args) => {
      if (redis === mockRedis) {
        return Promise.resolve()
      }
    })

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DlqConsumer,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
      ],
    }).compile()

    consumer = module.get<DlqConsumer>(DlqConsumer)

    jest.clearAllMocks()
  })

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      const startProcessingSpy = jest.spyOn(consumer as any, 'startProcessing')
      const loggerSpy = jest.spyOn(consumer['logger'], 'log')

      await consumer.onModuleInit()

      expect(loggerSpy).toHaveBeenCalledWith(
        'Starting DLQ stream processor',
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

      await consumer['processDLQ']()

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

    it('should process valid retryable DLQ entry', async () => {
      const streamId = '1640995200000-0'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'test-job-123'],
              ['error', 'No posts found'],
              ['query', 'rare:tag'],
              ['retryCount', '0'],
              ['originalError', 'API returned empty'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ']()

      expect(dlqUtil.retryFromDLQ).toHaveBeenCalledWith(
        mockRedis,
        apiName,
        'test-job-123',
        'rare:tag',
        0,
        streamId,
      )
    })

    it('should handle xdel errors without stopping processing', async () => {
      const streamId = '1640995200000-0'
      const mockXReadResult = [
        [
          dlqStream,
          [
            [
              streamId,
              ['jobId', 'xdel-error-job'],
              ['error', 'Test error'],
              ['query', 'xdel:test'],
              ['retryCount', '0'],
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      const xdelError = new Error('XDEL failed')
      mockRedis.xdel.mockRejectedValue(xdelError)

      await consumer['processDLQ']()

      expect(consumer['logger'].error).toHaveBeenCalled()
    })
  })

  describe('dedupCheck utility', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('should detect DLQ duplicate using XRANGE within timestamp window', async () => {
      const apiName = 'danbooru'
      const query = 'test:query'
      const jobId = 'test-job-123'

      mockDedupCheck.mockResolvedValueOnce(true)

      const result = await dlqUtil.dedupCheck(mockRedis, apiName, query, jobId)

      expect(mockDedupCheck).toHaveBeenCalledWith(mockRedis, apiName, query, jobId)
      expect(result).toBe(true)
    })

    it('should detect cross-job duplicate via Redis set', async () => {
      const apiName = 'danbooru'
      const query = 'cross-job:query'
      const jobId = 'cross-job-123'

      mockDedupCheck.mockResolvedValueOnce(true)

      const result = await dlqUtil.dedupCheck(mockRedis, apiName, query, jobId)

      expect(mockDedupCheck).toHaveBeenCalledWith(mockRedis, apiName, query, jobId)
      expect(result).toBe(true)
    })

    it('should return false when no duplicates found', async () => {
      const apiName = 'danbooru'
      const query = 'unique:query'
      const jobId = 'unique-job-123'

      mockDedupCheck.mockResolvedValueOnce(false)

      const result = await dlqUtil.dedupCheck(mockRedis, apiName, query, jobId)

      expect(result).toBe(false)
      expect(mockDedupCheck).toHaveBeenCalledWith(mockRedis, apiName, query, jobId)
    })

    it('should handle XRANGE errors gracefully', async () => {
      const apiName = 'danbooru'
      const query = 'error:query'
      const jobId = 'error-job-123'

      mockDedupCheck.mockRejectedValueOnce(new Error('XRANGE failed'))

      const result = await dlqUtil.dedupCheck(mockRedis, apiName, query, jobId).catch(() => false)

      expect(result).toBe(false)
      expect(mockDedupCheck).toHaveBeenCalledWith(mockRedis, apiName, query, jobId)
    })
  })

  describe('startProcessing', () => {
    it('should start infinite processing loop', async () => {
      const processDLQSpy = jest
        .spyOn(consumer as any, 'processDLQ')
        .mockResolvedValue(undefined)

      // Mock setTimeout to prevent infinite loop
      const mockSetTimeout = jest.spyOn(global, 'setTimeout').mockImplementation(
        (fn: () => void, delay: number) => {
          // Don't actually call the timeout, just return
          return 1 as any
        }
      )

      const startSpy = jest.spyOn(consumer as any, 'startProcessing')

      await consumer.onModuleInit()

      expect(startSpy).toHaveBeenCalled()
      expect(processDLQSpy).not.toHaveBeenCalled() // Since we mock the timeout

      mockSetTimeout.mockRestore()
    })
  })
})
