import { Test, TestingModule } from '@nestjs/testing'
import { DlqConsumer } from './dlq.consumer'
import Redis from 'ioredis'
import * as dlqUtil from './utils/dlq.util'
import { MAX_DLQ_RETRIES } from '../constants'
import { Logger } from '@nestjs/common'

jest.mock('./utils/dlq.util')

const mockRetryFromDLQ = jest.mocked(dlqUtil.retryFromDLQ)
const mockMoveToDeadQueue = jest.mocked(dlqUtil.moveToDeadQueue)

describe('DlqConsumer', () => {
  let consumer: DlqConsumer
  let mockRedis: jest.Mocked<Redis>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    mockRedis = {
      xread: jest.fn(),
      xdel: jest.fn(),
    } as any

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any

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

  describe('onModuleInit', () => {
    it('should start DLQ processing on module init', async () => {
      const startProcessingSpy = jest.spyOn(consumer as any, 'startProcessing')

      await consumer.onModuleInit()

      expect(mockLogger.log).toHaveBeenCalledWith(
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
              'jobId',
              'test-job-123',
              'error',
              'No posts found',
              'query',
              'rare:tag',
              'retryCount',
              '0',
              'originalError',
              'API returned empty',
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      mockRetryFromDLQ.mockResolvedValue({ success: true })
      mockRedis.xdel.mockResolvedValue(1)

      await consumer['processDLQ']()

      expect(mockRetryFromDLQ).toHaveBeenCalledWith(
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
              'jobId',
              'xdel-error-job',
              'error',
              'Test error',
              'query',
              'xdel:test',
              'retryCount',
              '0',
            ],
          ],
        ],
      ] as any

      mockRedis.xread.mockResolvedValue(mockXReadResult)
      const xdelError = new Error('XDEL failed')
      mockRedis.xdel.mockRejectedValue(xdelError)
      mockRetryFromDLQ.mockResolvedValue({ success: true })

      await consumer['processDLQ']()

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('XDEL failed'),
      )
    })
  })

  describe('startProcessing', () => {
    it('should continuously process DLQ with 1 second intervals', async () => {
      const processDLQSpy = jest
        .spyOn(consumer as any, 'processDLQ')
        .mockResolvedValue(undefined)

      // Mock setInterval to control timing
      const mockSetInterval = jest.spyOn(global, 'setInterval').mockImplementation(
        (fn: () => void, delay: number) => {
          // Run the first call immediately
          fn()
          // Return a fake interval ID
          return 1 as any
        }
      )

      const processingPromise = consumer['startProcessing']()

      // Run one more cycle
      jest.useFakeTimers()
      jest.advanceTimersByTime(1000)
      jest.runAllTimers()
      jest.useRealTimers()

      expect(processDLQSpy).toHaveBeenCalledTimes(2)

      mockSetInterval.mockRestore()
      jest.clearAllTimers()

      await processingPromise.catch(() => {})
    }, 5000)
  })
})
