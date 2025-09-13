import { Test, TestingModule } from '@nestjs/testing'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { Job } from 'bullmq'
import Redis from 'ioredis'
import { ModuleRef } from '@nestjs/core'
import { DanbooruService } from '../../danbooru/danbooru.service'
import { ValidationService } from '../../danbooru/validation.service'
import { LockUtil } from '../redis/utils/lock.util'
import * as dlqUtil from './utils/dlq.util'
import {
  DEDUP_TTL_SECONDS,
  QUERY_LOCK_TIMEOUT_SECONDS,
} from '../../common/constants'
import * as crypto from 'crypto'
import { Logger } from '@nestjs/common'

interface JobData {
  query: string
  clientId?: string
  apiPrefix?: string
}

interface ValidationResult {
  valid: boolean
  dto?: {
    jobId: string
    query: string
  }
  error?: {
    type: 'error'
    jobId: string
    error: string
    code?: string
  }
}

type TestConsumer = Omit<
  RedisStreamConsumer,
  'danbooruService' | 'validationService'
> & {
  acquireLock(
    key: string,
    value: string,
    maxRetries?: number,
  ): Promise<string | null>
  releaseLock(key: string, value: string): Promise<boolean>
  process(
    job: Job<JobData, unknown, string>,
  ): Promise<{ success: boolean } | { skipped: boolean; reason: string }>
  redis: Redis
  lockUtil: LockUtil
  onModuleInit(): Promise<void>
  onModuleDestroy(): Promise<void>
}

jest.mock('../../danbooru/danbooru.service')
jest.mock('../../danbooru/validation.service')
jest.mock('./utils/dlq.util')
jest.mock('crypto')
jest.mock('../redis/utils/lock.util')

const mockDedupCheck = jest.mocked(dlqUtil.dedupCheck)
const mockAddToDLQ = jest.mocked(dlqUtil.addToDLQ)
const mockCryptoRandomUUID = jest.mocked(crypto.randomUUID)

describe('RedisStreamConsumer', () => {
  let consumer: TestConsumer
  let mockRedis: Partial<jest.Mocked<Redis>>
  let mockModuleRef: Partial<jest.Mocked<ModuleRef>>
  let mockLogger: Partial<jest.Mocked<Logger>>
  let mockDanbooruServiceInstance: Partial<jest.Mocked<DanbooruService>>
  let mockValidationServiceInstance: Partial<jest.Mocked<ValidationService>>
  let mockLockUtilInstance: Partial<jest.Mocked<LockUtil>>
  let module: TestingModule

  beforeEach(async () => {
    mockRedis = {
      set: jest.fn(),
      xadd: jest.fn(),
    }

    mockModuleRef = {
      get: jest.fn(),
    }

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }

    mockDanbooruServiceInstance = {
      processRequest: jest.fn().mockResolvedValue(undefined),
    }

    mockValidationServiceInstance = {
      validateRequest: jest.fn(),
    }

    mockLockUtilInstance = {
      acquireLock: jest.fn().mockResolvedValue('mock-lock-value'),
      releaseLock: jest.fn().mockResolvedValue(true),
    }
    ;(mockModuleRef.get as jest.Mock)
      .mockImplementationOnce(() => mockDanbooruServiceInstance)
      .mockImplementationOnce(() => mockValidationServiceInstance)

    mockCryptoRandomUUID.mockReturnValue('123e4567-e89b-12d3-a456-426614174000')
    ;(
      crypto.createHash as jest.MockedFunction<typeof crypto.createHash>
    ).mockImplementation(
      () =>
        ({
          update: jest.fn().mockReturnThis(),
          digest: jest.fn().mockReturnValue('test-query-hash'),
        }) as unknown as ReturnType<typeof crypto.createHash>,
    )

    mockDedupCheck.mockResolvedValue(false)
    ;(mockRedis.set as jest.Mock)
      .mockResolvedValueOnce('OK') // Job dedup
      .mockResolvedValue('OK')

    module = await Test.createTestingModule({
      providers: [
        RedisStreamConsumer,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: LockUtil, useValue: mockLockUtilInstance },
        { provide: ModuleRef, useValue: mockModuleRef },
        { provide: Logger, useValue: mockLogger },
      ],
    }).compile()

    consumer = module.get<RedisStreamConsumer>(
      RedisStreamConsumer,
    ) as unknown as TestConsumer

    // Reset mocks
    jest.clearAllMocks()
  })

  describe('process', () => {
    const mockJobData: JobData = {
      query: 'cat rating:safe',
      clientId: 'user123',
    }
    const mockJob = { data: mockJobData } as Job<JobData>
    const jobId = '123e4567-e89b-12d3-a456-426614174000'
    const queryHash = 'test-query-hash'
    const lockKey = `lock:query:danbooru:test-query-hash`

    beforeEach(() => {
      mockCryptoRandomUUID.mockReturnValue(jobId)
      ;(
        crypto.createHash as jest.MockedFunction<typeof crypto.createHash>
      ).mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue(queryHash),
          }) as unknown as ReturnType<typeof crypto.createHash>,
      )

      mockDedupCheck.mockResolvedValue(false)
      ;(mockRedis.set as jest.Mock).mockResolvedValueOnce('OK') // Job dedup
      ;(mockLockUtilInstance.acquireLock as jest.Mock).mockResolvedValue(jobId)
      ;(mockLockUtilInstance.releaseLock as jest.Mock).mockResolvedValue(true)
    })

    it('should process job successfully with all validations passing', async () => {
      ;(
        mockValidationServiceInstance.validateRequest as jest.Mock
      ).mockResolvedValue({
        valid: true,
        dto: { jobId, query: 'cat rating:safe' },
      } as ValidationResult)
      ;(
        mockDanbooruServiceInstance.processRequest as jest.Mock
      ).mockResolvedValue({} as unknown)

      const result = await consumer.process(mockJob)

      expect(result).toEqual({ success: true })

      expect(mockDedupCheck).toHaveBeenCalledWith(
        mockRedis as unknown as Redis,
        'danbooru',
        'cat rating:safe',
        jobId,
      )

      expect(mockCryptoRandomUUID).toHaveBeenCalled()

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(`Processing job ${jobId} for query`),
        jobId,
      )

      expect(mockRedis.set).toHaveBeenCalledWith(
        `processed:${jobId}`,
        '1',
        'EX',
        DEDUP_TTL_SECONDS,
        'NX',
      )

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalledWith(
        lockKey,
        QUERY_LOCK_TIMEOUT_SECONDS,
      )

      expect(mockModuleRef.get).toHaveBeenCalledWith(DanbooruService, {
        strict: false,
      })

      expect(mockModuleRef.get).toHaveBeenCalledWith(ValidationService, {
        strict: false,
      })

      expect(
        mockValidationServiceInstance.validateRequest,
      ).toHaveBeenCalledWith({ ...mockJobData, apiPrefix: 'danbooru' })

      expect(mockDanbooruServiceInstance.processRequest).toHaveBeenCalledWith(
        jobId,
        'cat rating:safe',
        'user123',
      )

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        jobId,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
      )
    })

    it('should skip processing on DLQ duplicate detection', async () => {
      mockDedupCheck.mockResolvedValueOnce(true)

      const result = await consumer.process(mockJob)

      expect(result).toEqual({ skipped: true, reason: 'DLQ duplicate' })

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Recent duplicate query found in DLQ'),
        jobId,
      )

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Duplicate request detected'),
      )

      expect(mockLockUtilInstance.acquireLock).not.toHaveBeenCalled()

      expect(
        mockValidationServiceInstance.validateRequest,
      ).not.toHaveBeenCalled()

      expect(mockModuleRef.get).not.toHaveBeenCalled()
    })

    it('should skip processing when lock acquisition fails', async () => {
      mockDedupCheck.mockResolvedValueOnce(false)
      ;(mockLockUtilInstance.acquireLock as jest.Mock).mockResolvedValueOnce(
        null,
      )

      const result = await consumer.process(mockJob)

      expect(result).toEqual({ skipped: true, reason: 'lock failed' })

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to acquire query lock'),
        jobId,
      )

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Query currently being processed'),
      )

      expect(
        mockValidationServiceInstance.validateRequest,
      ).not.toHaveBeenCalled()

      expect(mockModuleRef.get).not.toHaveBeenCalled()

      expect(mockLockUtilInstance.releaseLock).not.toHaveBeenCalled()
    })

    it('should skip processing on job-level duplicate detection', async () => {
      mockDedupCheck.mockResolvedValueOnce(false)
      ;(mockRedis.set as jest.Mock).mockResolvedValueOnce(null) // Job dedup fails

      const result = await consumer.process(mockJob)

      expect(result).toEqual({ skipped: true, reason: 'job duplicate' })

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate job'),
        jobId,
      )

      expect(
        mockValidationServiceInstance.validateRequest,
      ).not.toHaveBeenCalled()

      expect(mockDanbooruServiceInstance.processRequest).not.toHaveBeenCalled()

      expect(mockLockUtilInstance.acquireLock).not.toHaveBeenCalled()

      expect(mockModuleRef.get).not.toHaveBeenCalled()
    })

    it('should handle validation failure and add to DLQ', async () => {
      mockDedupCheck
        .mockResolvedValueOnce(false) // Initial DLQ check
        .mockResolvedValueOnce(false) // Validation DLQ check
      ;(mockRedis.set as jest.Mock).mockResolvedValueOnce('OK') // Job dedup

      const validationError = {
        type: 'error' as const,
        jobId,
        error: 'Invalid query format',
        code: 'INVALID_QUERY',
      }

      ;(
        mockValidationServiceInstance.validateRequest as jest.Mock
      ).mockResolvedValue({
        valid: false,
        error: validationError,
      } as ValidationResult)

      await expect(consumer.process(mockJob)).rejects.toThrow(
        'Validation failed: Invalid query format',
      )

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed for job'),
        jobId,
      )

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Invalid query format'),
      )

      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis as unknown as Redis,
        'danbooru',
        jobId,
        'Invalid query format',
        'cat rating:safe',
      )

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalled()

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalled()
    })

    it('should skip DLQ entry for validation error if recent duplicate exists', async () => {
      mockDedupCheck
        .mockResolvedValueOnce(false) // Initial DLQ
        .mockResolvedValueOnce(true) // Validation DLQ check
      ;(mockRedis.set as jest.Mock).mockResolvedValueOnce('OK')
      ;(
        mockValidationServiceInstance.validateRequest as jest.Mock
      ).mockResolvedValue({
        valid: false,
        error: { type: 'error' as const, jobId, error: 'Invalid format' },
      } as ValidationResult)

      await expect(consumer.process(mockJob)).rejects.toThrow(
        'Validation failed: Invalid format',
      )

      expect(mockAddToDLQ).not.toHaveBeenCalled()

      expect(mockRedis.xadd).toHaveBeenCalled()

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalled()

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalled()
    })

    it('should release lock even when processing succeeds', async () => {
      ;(
        mockValidationServiceInstance.validateRequest as jest.Mock
      ).mockResolvedValue({
        valid: true,
        dto: { jobId, query: 'test' },
      } as ValidationResult)
      ;(
        mockDanbooruServiceInstance.processRequest as jest.Mock
      ).mockResolvedValue({} as unknown)

      await consumer.process(mockJob)

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalled()

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        jobId,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
      )
    })

    it('should release lock even when unexpected error occurs', async () => {
      ;(
        mockValidationServiceInstance.validateRequest as jest.Mock
      ).mockResolvedValue({
        valid: true,
        dto: { jobId, query: 'test' },
      } as ValidationResult)
      ;(
        mockDanbooruServiceInstance.processRequest as jest.Mock
      ).mockRejectedValue(new Error('Processing failed'))

      await expect(consumer.process(mockJob)).rejects.toThrow(
        'Processing failed',
      )

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalled()

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        jobId,
      )
    })
  })

  describe('acquireLock', () => {
    const lockKey = 'lock:test'
    const jobId = '123e4567-e89b-12d3-a456-426614174000'

    beforeEach(() => {
      mockCryptoRandomUUID.mockReturnValue(jobId)
    })

    it('should acquire lock on first attempt', async () => {
      ;(mockLockUtilInstance.acquireLock as jest.Mock).mockResolvedValueOnce(
        'acquired-lock-value',
      )

      const result = await consumer.acquireLock(lockKey, jobId, 1)

      expect(result).toBe('acquired-lock-value')

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalledWith(
        lockKey,
        QUERY_LOCK_TIMEOUT_SECONDS,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock acquired'),
      )
    })

    it('should retry with exponential backoff on lock contention', async () => {
      ;(mockLockUtilInstance.acquireLock as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('acquired-lock-value')

      const result = await consumer.acquireLock(lockKey, jobId, 2)

      expect(result).toBe('acquired-lock-value')

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalledTimes(2)

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock acquisition failed'),
        jobId,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock acquired'),
      )
    })

    it('should fail after max retries', async () => {
      ;(mockLockUtilInstance.acquireLock as jest.Mock).mockResolvedValue(null)

      const result = await consumer.acquireLock(lockKey, jobId, 2)

      expect(result).toBe(null)

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalledTimes(2)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to acquire lock after 2 retries'),
        jobId,
      )
    })

    it('should use default maxRetries of 3', async () => {
      ;(mockLockUtilInstance.acquireLock as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('acquired-lock-value')

      await consumer.acquireLock(lockKey, jobId)

      expect(mockLockUtilInstance.acquireLock).toHaveBeenCalledTimes(3)
    })
  })

  describe('releaseLock', () => {
    const lockKey = 'lock:test'
    const lockValue = 'mock-lock-value'

    it('should release lock when owned by current job', async () => {
      ;(mockLockUtilInstance.releaseLock as jest.Mock).mockResolvedValueOnce(
        true,
      )

      await consumer.releaseLock(lockKey, lockValue)

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        lockValue,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
      )
    })

    it('should not release lock when not owned by current job', async () => {
      ;(mockLockUtilInstance.releaseLock as jest.Mock).mockResolvedValueOnce(
        false,
      )

      await consumer.releaseLock(lockKey, lockValue)

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        lockValue,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock not owned'),
      )
    })

    it('should handle lock key not existing', async () => {
      ;(mockLockUtilInstance.releaseLock as jest.Mock).mockResolvedValueOnce(
        false,
      )

      await consumer.releaseLock(lockKey, lockValue)

      expect(mockLockUtilInstance.releaseLock).toHaveBeenCalledWith(
        lockKey,
        lockValue,
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock not owned'),
      )
    })
  })

  describe('onModuleInit and onModuleDestroy', () => {
    it('should call onModuleInit without errors', async () => {
      await consumer.onModuleInit()

      expect(mockLogger).not.toHaveBeenCalled()
    })

    it('should call onModuleDestroy without errors', async () => {
      await consumer.onModuleDestroy()

      expect(mockLogger).not.toHaveBeenCalled()
    })
  })

  describe('dependency injection', () => {
    it('should properly inject Redis client', () => {
      const redisConsumer = new RedisStreamConsumer(
        mockRedis as unknown as Redis,
        mockLockUtilInstance as unknown as LockUtil,
        mockModuleRef as unknown as ModuleRef,
      ) as unknown as TestConsumer
      expect(redisConsumer.redis).toBe(mockRedis)
    })

    it('should properly inject LockUtil', () => {
      const lockConsumer = new RedisStreamConsumer(
        mockRedis as unknown as Redis,
        mockLockUtilInstance as unknown as LockUtil,
        mockModuleRef as unknown as ModuleRef,
      ) as unknown as TestConsumer
      expect(lockConsumer.lockUtil).toBe(mockLockUtilInstance)
    })

    it('should lazy-load services via ModuleRef', async () => {
      const testConsumer = module.get<RedisStreamConsumer>(
        RedisStreamConsumer,
      ) as unknown as TestConsumer

      const mockTestJob = { data: { query: 'test' } } as Job<JobData>
      await testConsumer.process(mockTestJob)

      expect(mockModuleRef.get).toHaveBeenCalledWith(DanbooruService, {
        strict: false,
      })

      expect(mockModuleRef.get).toHaveBeenCalledWith(ValidationService, {
        strict: false,
      })
    })
  })
})
