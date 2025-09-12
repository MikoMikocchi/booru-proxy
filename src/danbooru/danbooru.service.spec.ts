import { Test, TestingModule } from '@nestjs/testing';
import { DanbooruService } from './danbooru.service';
import { DanbooruApiService } from './danbooru-api.service';
import { CacheService } from '../common/cache/cache.service';
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import * as dlqUtil from '../common/queues/utils/dlq.util';
import { Logger } from '@nestjs/common';

jest.mock('./danbooru-api.service');
jest.mock('../common/cache/cache.service');
jest.mock('../common/rate-limit/rate-limit-manager.service');
jest.mock('../common/queues/utils/dlq.util');
jest.mock('ioredis');

const mockDanbooruApiService = jest.mocked(DanbooruApiService);
const mockCacheService = jest.mocked(CacheService);
const mockRateLimitManager = jest.mocked(RateLimitManagerService);
const mockAddToDLQ = jest.mocked(dlqUtil.addToDLQ);
const mockRedis = jest.mocked(Redis);

interface MockDanbooruApiService {
  fetchPosts: jest.MockedFunction<any>;
}

interface MockCacheService {
  getCachedResponse: jest.MockedFunction<any>;
  setCache: jest.MockedFunction<any>;
}

interface MockRateLimitManager {
  checkRateLimit: jest.MockedFunction<any>;
}

describe('DanbooruService', () => {
  let service: DanbooruService;
  let mockApiService: MockDanbooruApiService;
  let mockCacheService: MockCacheService;
  let mockRateLimitManager: MockRateLimitManager;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(async () => {
    mockApiService = {
      fetchPosts: jest.fn(),
    };

    mockCacheService = {
      getCachedResponse: jest.fn(),
      setCache: jest.fn(),
    };

    mockRateLimitManager = {
      checkRateLimit: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DanbooruService,
        { provide: DanbooruApiService, useValue: mockApiService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: RateLimitManagerService, useValue: mockRateLimitManager },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: Logger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<DanbooruService>(DanbooruService);

    jest.clearAllMocks();
  });

  describe('processRequest', () => {
    const jobId = 'test-job-123';
    const query = 'cat rating:safe';
    const clientId = 'user123';
    const lockKey = 'lock:query:test-query-hash';
    const mockPost = {
      id: 1,
      file_url: 'https://example.com/image.jpg',
      tag_string_artist: 'artist',
      tag_string_general: 'cat rating:safe',
      rating: 's',
      source: 'source',
      tag_string_copyright: 'copyright',
    };

    beforeEach(() => {
      // Mock crypto hash
      (crypto.createHash as jest.MockedFunction<typeof crypto.createHash>).mockImplementation(() => ({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('test-query-hash'),
      }) as any);

      // Mock Redis for lock
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.get.mockResolvedValue(jobId);
      mockRedis.del.mockResolvedValue(1);
    });

    it('should process request successfully with cache miss', async () => {
      // Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      // Mock cache miss
      mockCacheService.getCachedResponse.mockResolvedValue(null);

      // Mock API success
      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      const result = await service.processRequest(jobId, query, clientId);

      expect(result).toEqual({
        type: 'success',
        jobId,
        imageUrl: 'https://example.com/image.jpg',
        author: 'artist',
        tags: 'cat rating:safe',
        rating: 's',
        source: 'source',
        copyright: 'copyright',
      });

      // Verify rate limit check
      expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
        'danbooru',
        jobId,
        clientId,
      );

      // Verify cache miss
      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        false,
      );

      // Verify API call
      expect(mockApiService.fetchPosts).toHaveBeenCalledWith(
        query,
        1,
        false,
      );

      // Verify response published
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining(JSON.stringify(result)),
      );

      // Verify cache set
      expect(mockCacheService.setCache).toHaveBeenCalledWith(
        'danbooru',
        query,
        result,
        false,
      );

      // Verify lock released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should return cached response when cache hit (random=false)', async () => {
      const cachedResponse = {
        type: 'success',
        jobId: 'cached-job',
        imageUrl: 'https://cached.com/image.jpg',
        author: 'cached artist',
        tags: 'cached:tags',
        rating: 'q',
        source: 'cached source',
        copyright: 'cached copyright',
      };

      // Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      // Mock cache hit
      mockConfigService.get.mockReturnValueOnce(false); // DANBOORU_RANDOM = false
      mockCacheService.getCachedResponse.mockResolvedValue(cachedResponse);

      const result = await service.processRequest(jobId, query, clientId);

      expect(result).toEqual(cachedResponse);

      // Verify cache hit
      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        false,
      );

      // Verify response published
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining(JSON.stringify(cachedResponse)),
      );

      // Should not call API
      expect(mockApiService.fetchPosts).not.toHaveBeenCalled();
      expect(mockCacheService.setCache).not.toHaveBeenCalled();

      // Lock should be released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should fail rate limit check', async () => {
      const rateLimitError = {
        allowed: false,
        error: { error: 'Rate limit exceeded', code: 'RATE_LIMIT' },
      };
      mockRateLimitManager.checkRateLimit.mockResolvedValue(rateLimitError as any);

      const result = await service.processRequest(jobId, query, clientId);

      expect(result).toEqual(rateLimitError.error);

      // Verify rate limit error published
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Rate limit exceeded'),
      );

      // Should not call cache or API
      expect(mockCacheService.getCachedResponse).not.toHaveBeenCalled();
      expect(mockApiService.fetchPosts).not.toHaveBeenCalled();
      expect(mockCacheService.setCache).not.toHaveBeenCalled();
      expect(mockAddToDLQ).not.toHaveBeenCalled();

      // Lock should be released even on rate limit failure
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should handle API failure and add to DLQ', async () => {
      // Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      // Mock cache miss
      mockCacheService.getCachedResponse.mockResolvedValue(null);

      // Mock API failure
      const apiError = new Error('API server error');
      mockApiService.fetchPosts.mockRejectedValue(apiError);

      const result = await service.processRequest(jobId, query, clientId);

      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'No posts found for the query or API error',
      });

      // Verify error published
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('No posts found for the query or API error'),
      );

      // Verify added to DLQ
      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis,
        'danbooru',
        jobId,
        'No posts found for the query or API error',
        query,
        0,
      );

      // Lock should be released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should handle processing errors and add to DLQ', async () => {
      // Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      // Mock cache miss
      mockCacheService.getCachedResponse.mockResolvedValue(null);

      // Mock API success
      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      // Mock error in response building/publishing
      const publishError = new Error('Publish failed');
      const originalProcessRequest = mockDanbooruServiceInstance.publishResponse;
      mockDanbooruServiceInstance.publishResponse = jest.fn().mockRejectedValue(publishError);

      await expect(service.processRequest(jobId, query, clientId)).rejects.toThrow('Publish failed');

      // Verify API was called
      expect(mockApiService.fetchPosts).toHaveBeenCalled();

      // Verify error was added to DLQ
      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis,
        'danbooru',
        jobId,
        'Publish failed',
        query,
        0,
      );

      // Lock should be released even on error
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });

    it('should use random=false when configured', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      mockConfigService.get.mockReturnValueOnce(false); // DANBOORU_RANDOM = false

      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      await service.processRequest(jobId, query, clientId);

      // Should check cache when random=false
      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        false,
      );

      // Should cache response when random=false
      expect(mockCacheService.setCache).toHaveBeenCalledWith(
        'danbooru',
        query,
        expect.any(Object),
        false,
      );
    });

    it('should use random=true when configured (default)', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      mockConfigService.get.mockReturnValueOnce(true); // DANBOORU_RANDOM = true

      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      await service.processRequest(jobId, query, clientId);

      // Should not check cache when random=true
      expect(mockCacheService.getCachedResponse).not.toHaveBeenCalled();

      // Should not cache response when random=true
      expect(mockCacheService.setCache).not.toHaveBeenCalled();
    });

    it('should use configurable limit from config', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      mockConfigService.get
        .mockReturnValueOnce(true) // DANBOORU_RANDOM = true
        .mockReturnValueOnce(5); // DANBOORU_LIMIT = 5

      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      await service.processRequest(jobId, query, clientId);

      // Should use configured limit
      expect(mockApiService.fetchPosts).toHaveBeenCalledWith(
        query,
        5,
        true,
      );
    });

    it('should release lock when query lock not acquired', async () => {
      mockRedis.set.mockResolvedValueOnce(null); // Lock not acquired

      const result = await service.processRequest(jobId, query, clientId);

      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'Query is currently being processed',
      });

      // Lock should not be released since it was never acquired
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should release lock even when API call succeeds', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      mockCacheService.getCachedResponse.mockResolvedValue(null);

      mockApiService.fetchPosts.mockResolvedValue(mockPost);

      mockRedis.set.mockResolvedValueOnce('OK'); // Lock acquired
      mockRedis.get.mockResolvedValueOnce(jobId); // Lock owned by current job
      mockRedis.del.mockResolvedValue(1);

      await service.processRequest(jobId, query, clientId);

      // Lock should be released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Service-level query lock released'),
        jobId,
      );
    });

    it('should release lock even when unexpected errors occur', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any);

      mockCacheService.getCachedResponse.mockResolvedValue(null);

      // Simulate error after lock acquisition
      const apiError = new Error('API error');
      mockApiService.fetchPosts.mockRejectedValue(apiError);

      mockRedis.set.mockResolvedValueOnce('OK'); // Lock acquired
      mockRedis.get.mockResolvedValueOnce(jobId); // Lock owned by current job

      await service.processRequest(jobId, query, clientId);

      // Lock should be released in finally block
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey);
    });
  });

  describe('publishResponse', () => {
    it('should publish response to Redis stream', async () => {
      const mockResponse = {
        type: 'success',
        jobId,
        imageUrl: 'https://example.com/image.jpg',
      };

      await service['publishResponse'](jobId, mockResponse);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        JSON.stringify({
          ...mockResponse,
          timestamp: expect.any(Number),
        }),
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(`Published response for job ${jobId}`),
      );
    });

    it('should include timestamp in published response', async () => {
      const mockResponse = {
        type: 'success',
        jobId,
      };

      await service['publishResponse'](jobId, mockResponse);

      const publishedData = JSON.parse((mockRedis.xadd as jest.Mock).mock.calls[0][5] as string);

      expect(publishedData.timestamp).toBeGreaterThan(0);
      expect(publishedData.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('buildSuccessResponse', () => {
    it('should build proper success response from post data', () => {
      const mockPost = {
        id: 1,
        file_url: 'https://example.com/image.jpg',
        tag_string_artist: 'artist',
        tag_string_general: 'cat rating:safe',
        rating: 's',
        source: 'source',
        tag_string_copyright: 'copyright',
      };

      mockLogger.log.mockReturnValue(undefined);

      const result = service['buildSuccessResponse'](mockPost, jobId);

      expect(result).toEqual({
        type: 'success',
        jobId,
        imageUrl: 'https://example.com/image.jpg',
        author: 'artist',
        tags: 'cat rating:safe',
        rating: 's',
        source: 'source',
        copyright: 'copyright',
      });

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining(`Found post for job ${jobId}: author artist`),
        jobId,
      );
    });

    it('should handle null source', () => {
      const mockPost = {
        id: 1,
        file_url: 'https://example.com/image.jpg',
        tag_string_artist: 'artist',
        tag_string_general: 'cat rating:safe',
        rating: 's',
        source: null,
        tag_string_copyright: 'copyright',
      };

      const result = service['buildSuccessResponse'](mockPost, jobId);

      expect(result.source).toBeNull();
    });
  });

  describe('handleApiError', () => {
    it('should handle API error and add to DLQ', async () => {
      const errorMessage = 'No posts found for the query or API error';
      const mockQuery = 'test:query';

      mockRedis.xadd.mockResolvedValue(1);
      mockAddToDLQ.mockResolvedValue(undefined);

      const result = await service['handleApiError'](errorMessage, jobId, mockQuery);

      expect(result).toEqual({
        type: 'error',
        jobId,
        error: errorMessage,
      });

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining(errorMessage),
      );

      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis,
        'danbooru',
        jobId,
        errorMessage,
        mockQuery,
        0,
      );
    });
  });

  describe('handleProcessingError', () => {
    it('should handle processing error and add to DLQ', async () => {
      const error = new Error('Processing failed');
      const mockQuery = 'process:error';

      mockRedis.xadd.mockResolvedValue(1);
      mockAddToDLQ.mockResolvedValue(undefined);

      const result = await service['handleProcessingError'](error, jobId, mockQuery);

      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'Processing failed',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Error processing job ${jobId}: Processing failed`),
        jobId,
      );

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining('Processing failed'),
      );

      expect(mockAddToDLQ).toHaveBeenCalledWith(
        mockRedis,
        'danbooru',
        jobId,
        'Processing failed',
        mockQuery,
        0,
      );
    });

    it('should handle non-Error processing errors', async () => {
      const error = 'String error';
      const mockQuery = 'string:error';

      mockRedis.xadd.mockResolvedValue(1);
      mockAddToDLQ.mockResolvedValue(undefined);

      const result = await service['handleProcessingError'](error, jobId, mockQuery);

      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'String error',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Error processing job ${jobId}: String error`),
        jobId,
      );
    });
  });
});
