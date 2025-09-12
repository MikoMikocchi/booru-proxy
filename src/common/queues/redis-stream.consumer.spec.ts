import { Test, TestingModule } from '@nestjs/testing';
import { RedisStreamConsumer } from './redis-stream.consumer';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ModuleRef } from '@nestjs/core';
import { DanbooruService } from '../../danbooru/danbooru.service';
import { ValidationService } from '../../common/validation/validation.service';
import * as dlqUtil from './utils/dlq.util';
import { DEDUP_TTL_SECONDS, QUERY_LOCK_TIMEOUT_SECONDS } from '../../common/constants';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';

jest.mock('../../danbooru/danbooru.service');
jest.mock('../../common/validation/validation.service');
jest.mock('./utils/dlq.util');
jest.mock('crypto');

const mockDanbooruService = jest.mocked(DanbooruService);
const mockValidationService = jest.mocked(ValidationService);
const mockDedupCheck = jest.mocked(dlqUtil.dedupCheck);
const mockAddToDLQ = jest.mocked(dlqUtil.addToDLQ);
const mockCryptoRandomUUID = jest.mocked(crypto.randomUUID);

describe('RedisStreamConsumer', () => {
  let consumer: RedisStreamConsumer;
  let mockRedis: jest.Mocked<Redis>;
  let mockModuleRef: jest.Mocked<ModuleRef>;
  let mockLogger: jest.Mocked<Logger>;
  let mockDanbooruServiceInstance: jest.Mocked<any>;
  let mockValidationServiceInstance: jest.Mocked<any>;
  let module: TestingModule;

  beforeEach(async () => {
    mockRedis = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      xadd: jest.fn(),
    } as any;

    mockModuleRef = {
      get: jest.fn(),
    } as any;

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;

    mockDanbooruServiceInstance = {
      processRequest: jest.fn().mockResolvedValue(undefined),
      publishResponse: jest.fn().mockResolvedValue(undefined),
    };

    mockValidationServiceInstance = {
      validateRequest: jest.fn(),
    };

    mockModuleRef.get
      .mockImplementationOnce(() => mockDanbooruServiceInstance)
      .mockImplementationOnce(() => mockValidationServiceInstance);

    module = await Test.createTestingModule({
      providers: [
        RedisStreamConsumer,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: ModuleRef, useValue: mockModuleRef },
        { provide: Logger, useValue: mockLogger },
      ],
    }).compile();

    consumer = module.get<RedisStreamConsumer>(RedisStreamConsumer);

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('process', () => {
    const mockJobData = { query: 'cat rating:safe', clientId: 'user123' };
    const mockJob = { data: mockJobData } as Job;
    const jobId = '123e4567-e89b-12d3-a456-426614174000';
    const queryHash = 'test-query-hash';
    const lockKey = `lock:query:${queryHash}`;

    beforeEach(() => {
      mockCryptoRandomUUID.mockReturnValue(jobId);
      (crypto.createHash as jest.MockedFunction<typeof crypto.createHash>).mockImplementation(() => ({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue(queryHash),
      }) as any);

      mockDedupCheck.mockResolvedValue(false);
      mockRedis.set
        .mockResolvedValueOnce('OK') // Lock acquired
        .mockResolvedValueOnce('OK'); // Job dedup
    });

    it('should process job successfully with all validations passing', async () => {
      mockValidationServiceInstance.validateRequest.mockResolvedValue({
        valid: true,
        dto: { query: 'cat rating:safe' },
      } as any);

      mockDanbooruServiceInstance.processRequest.mockResolvedValue(undefined);

      const result = await consumer.process(mockJob);

      expect(result).toEqual({ success: true });

      expect(mockDedupCheck).toHaveBeenCalledWith(mockRedis, 'danbooru', 'cat rating:safe');
      expect(mockCryptoRandomUUID).toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(`Processing job ${jobId} for query`),
        jobId,
      );

      expect(mockRedis.set).toHaveBeenNthCalledWith(
        1,
        lockKey,
        jobId,
        'EX',
        QUERY_LOCK_TIMEOUT_SECONDS,
        'NX',
      );

      expect(mockRedis.set).toHaveBeenNthCalledWith(
        2,
        `processed:${jobId}`,
        '1',
        'EX',
        DEDUP_TTL_SECONDS,
        'NX',
      );

      expect(mockModuleRef.get).toHaveBeenCalledWith(DanbooruService);
      expect(mockModuleRef.get).toHaveBeenCalledWith(ValidationService);

      expect(mockValidationServiceInstance.validateRequest).toHaveBeenCalledWith(mockJobData);

      expect(mockDanbooruServiceInstance.processRequest).toHaveBeenCalledWith(
        jobId,
        'cat rating:safe',
        'user123'
      );

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
        jobId,
      );
    });

    it('should skip processing on DLQ duplicate detection', async () => {
      mockDedupCheck.mockResolvedValueOnce(true);

      const result = await consumer.process(mockJob);

      expect(result).toEqual({ skipped: true, reason: 'DLQ duplicate' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Recent duplicate query found in DLQ'),
        jobId,
      );

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Duplicate request detected'),
      );

      expect(mockRedis.set).not.toHaveBeenCalledWith(expect.stringContaining('lock:'));
      expect(mockValidationServiceInstance.validateRequest).not.toHaveBeenCalled();
      expect(mockModuleRef.get).not.toHaveBeenCalled();
    });

    it('should skip processing when lock acquisition fails', async () => {
      mockDedupCheck.mockResolvedValueOnce(false);
      mockRedis.set.mockResolvedValueOnce(null);

      const result = await consumer.process(mockJob);

      expect(result).toEqual({ skipped: true, reason: 'lock failed' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to acquire query lock'),
        jobId,
      );

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Query currently being processed'),
      );

      expect(mockValidationServiceInstance.validateRequest).not.toHaveBeenCalled();
      expect(mockModuleRef.get).not.toHaveBeenCalled();
    });

    it('should skip processing on job-level duplicate detection', async () => {
      mockDedupCheck.mockResolvedValueOnce(false);
      mockRedis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null);

      const result = await consumer.process(mockJob);

      expect(result).toEqual({ skipped: true });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate job'),
        jobId,
      );

      expect(mockValidationServiceInstance.validateRequest).not.toHaveBeenCalled();
      expect(mockDanbooruServiceInstance.processRequest).not.toHaveBeenCalled();
      expect(mockModuleRef.get).toHaveBeenCalledTimes(2);
    });

    it('should handle validation failure and add to DLQ', async () => {
      mockDedupCheck
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      mockRedis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      const validationError = {
        type: 'error' as const,
        jobId,
        error: 'Invalid query format',
        code: 'INVALID_QUERY',
      };

      mockValidationServiceInstance.validateRequest.mockResolvedValue({
        valid: false,
        error: validationError,
      } as any);

      mockDanbooruServiceInstance.publishResponse.mockResolvedValue();

      await consumer.process(mockJob);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed for job'),
        jobId,
      );

      expect(mockDanbooruServiceInstance.publishResponse).toHaveBeenCalledWith(jobId, validationError);
      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis,
        'danbooru',
        jobId,
        'Invalid query format',
        'cat rating:safe',
      );

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should skip DLQ entry for validation error if recent duplicate exists', async () => {
      mockDedupCheck
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      mockRedis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      mockValidationServiceInstance.validateRequest.mockResolvedValue({
        valid: false,
        error: { type: 'error', jobId, error: 'Invalid format' } as any,
      } as any);

      await consumer.process(mockJob);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping DLQ entry for validation error'),
        jobId,
      );

      expect(mockAddToDLQ).not.toHaveBeenCalled();
    });

    it('should release lock even when processing succeeds', async () => {
      mockDedupCheck.mockResolvedValueOnce(false);
      mockRedis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      mockValidationServiceInstance.validateRequest.mockResolvedValue({
        valid: true,
        dto: {},
      } as any);

      mockDanbooruServiceInstance.processRequest.mockResolvedValue();

      await consumer.process(mockJob);

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
        jobId,
      );
    });

    it('should release lock even when unexpected error occurs', async () => {
      mockDedupCheck.mockResolvedValueOnce(false);
      mockRedis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      mockValidationServiceInstance.validateRequest.mockResolvedValue({
        valid: true,
        dto: {},
      } as any);

      mockDanbooruServiceInstance.processRequest.mockRejectedValue(new Error('Processing failed'));

      await expect(consumer.process(mockJob)).rejects.toThrow('Processing failed');

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });
  });

  describe('acquireLock', () => {
    const lockKey = 'lock:test';
    const jobId = '123e4567-e89b-12d3-a456-426614174000';

    beforeEach(() => {
      mockCryptoRandomUUID.mockReturnValue(jobId);
    });

    it('should acquire lock on first attempt', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await (consumer as any).acquireLock(lockKey, jobId, 1);

      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        lockKey,
        jobId,
        'EX',
        QUERY_LOCK_TIMEOUT_SECONDS,
        'NX',
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock acquired'),
      );
    });

    it('should retry with exponential backoff on lock contention', async () => {
      mockRedis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('OK');

      const result = await (consumer as any).acquireLock(lockKey, jobId, 2);

      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock acquisition failed'),
        jobId,
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock acquired'),
      );
    });

    it('should fail after max retries', async () => {
      mockRedis.set.mockResolvedValue(null);

      const result = await (consumer as any).acquireLock(lockKey, jobId, 2);

      expect(result).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to acquire lock after 2 retries'),
        jobId,
      );
    });

    it('should use default maxRetries of 3', async () => {
      mockRedis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('OK');

      await (consumer as any).acquireLock(lockKey, jobId);

      expect(mockRedis.set).toHaveBeenCalledTimes(3);
    });
  });

  describe('releaseLock', () => {
    const lockKey = 'lock:test';
    const jobId = '123e4567-e89b-12d3-a456-426614174000';

    beforeEach(() => {
      mockCryptoRandomUUID.mockReturnValue(jobId);
    });

    it('should release lock when owned by current job', async () => {
      mockRedis.get.mockResolvedValueOnce(jobId);
      mockRedis.del.mockResolvedValueOnce(1);

      await (consumer as any).releaseLock(lockKey, jobId);

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Query lock released'),
        jobId,
      );
    });

    it('should not release lock when not owned by current job', async () => {
      mockRedis.get.mockResolvedValueOnce('different-job-id');

      await (consumer as any).releaseLock(lockKey, jobId);

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock not owned'),
        jobId,
      );
    });

    it('should handle lock key not existing', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await (consumer as any).releaseLock(lockKey, jobId);

      expect(mockRedis.get).toHaveBeenCalledWith(lockKey);
      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Lock not owned'),
        jobId,
      );
    });
  });

  describe('onModuleInit and onModuleDestroy', () => {
    it('should call onModuleInit without errors', async () => {
      await consumer.onModuleInit();
      expect(mockLogger).not.toHaveBeenCalled();
    });

    it('should call onModuleDestroy without errors', async () => {
      await consumer.onModuleDestroy();
      expect(mockLogger).not.toHaveBeenCalled();
    });
  });

  describe('dependency injection', () => {
    it('should properly inject Redis client', () => {
      const redisConsumer = new RedisStreamConsumer(mockRedis, mockModuleRef);
      expect((redisConsumer as any).redis).toBe(mockRedis);
    });

    it('should lazy-load services via ModuleRef', async () => {
      const testConsumer = module.get<RedisStreamConsumer>(RedisStreamConsumer);

      expect((testConsumer as any).danbooruService).toBeUndefined();
      expect((testConsumer as any).validationService).toBeUndefined();

      const mockTestJob = { data: { query: 'test' } } as Job;
      await testConsumer.process(mockTestJob);

      expect(mockModuleRef.get).toHaveBeenCalledWith(DanbooruService);
      expect(mockModuleRef.get).toHaveBeenCalledWith(ValidationService);
      expect((testConsumer as any).danbooruService).toBe(mockDanbooruServiceInstance);
      expect((testConsumer as any).validationService).toBe(mockValidationServiceInstance);
    });
  });
});
