import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import type { DanbooruErrorResponse } from './interfaces/danbooru.interface'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { LockUtil } from '../common/redis/utils/lock.util'
import { addToDLQ } from '../common/queues/utils/dlq.util'
import { QUERY_LOCK_TIMEOUT_SECONDS } from '../common/constants'
import type { RateLimitResult } from '../common/rate-limit/rate-limit-manager.service'

jest.mock('./danbooru-api.service')
jest.mock('../common/cache/cache.service')
jest.mock('../common/cache/cache-manager.service')
jest.mock('../common/rate-limit/rate-limit-manager.service')
jest.mock('ioredis')
jest.mock('crypto')
jest.mock('../common/redis/utils/lock.util')
jest.mock('../common/queues/utils/dlq.util')

const mockLockUtil = {
  acquireLock: jest.fn(),
  extendLock: jest.fn(),
  releaseLock: jest.fn(),
} as jest.MockedObject<LockUtil>

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  xadd: jest.fn(),
} as Partial<jest.Mocked<Redis>>

const mockCacheManagerService = {
  get: jest.fn(),
} as Partial<jest.Mocked<CacheManagerService>>

describe('DanbooruService', () => {
  let service: DanbooruService
  let mockApiService: jest.Mocked<DanbooruApiService>
  let mockCacheService: jest.Mocked<CacheService>
  let mockRateLimitManager: jest.Mocked<RateLimitManagerService>
  let mockConfigService: jest.Mocked<ConfigService>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    mockApiService = {
      fetchPosts: jest.fn(),
    } as unknown as jest.Mocked<DanbooruApiService>

    mockCacheService = {
      getCachedResponse: jest.fn(),
      setCache: jest.fn(),
      invalidateCache: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<CacheService>

    mockRateLimitManager = {
      checkRateLimit: jest.fn(),
    } as unknown as jest.Mocked<RateLimitManagerService>

    mockConfigService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as unknown as jest.Mocked<Logger>

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DanbooruService,
        { provide: DanbooruApiService, useValue: mockApiService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: CacheManagerService, useValue: mockCacheManagerService },
        { provide: RateLimitManagerService, useValue: mockRateLimitManager },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: Logger, useValue: mockLogger },
        { provide: LockUtil, useValue: mockLockUtil },
      ],
    }).compile()

    service = module.get<DanbooruService>(DanbooruService)

    jest.clearAllMocks()
  })

  describe('processRequest', () => {
    const jobId = 'test-job-123'
    const query = 'cat rating:safe'
    const clientId = 'user123'
    const lockKey = 'lock:query:test-query-hash'
    const mockPost = {
      id: 1,
      file_url: 'https://example.com/image.jpg',
      tag_string_artist: 'artist',
      tag_string_general: 'cat rating:safe',
      rating: 's',
      source: 'source',
      tag_string_copyright: 'copyright',
      score: 100,
      created_at: '2023-01-01T00:00:00Z',
    }

    beforeEach(() => {
      // Mock crypto hash
      const mockHash = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('test-query-hash'),
      }

      ;(crypto.createHash as jest.Mock).mockReturnValue(mockHash as unknown)

      // Mock LockUtil for new methods
      mockLockUtil.acquireLock.mockResolvedValue('lock-value')
      mockLockUtil.releaseLock.mockResolvedValue(true)

      // Mock Redis for publish
      mockRedis.xadd!.mockResolvedValue('1')

      // Mock DLQ for errors (via jest.mock)
      ;(addToDLQ as jest.Mock).mockResolvedValue(undefined)
    })

    it('should process request successfully with cache miss', async () => {
      // Arrange: Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as const)

      // Arrange: Mock cache miss (getOrFetchFromCache returns null)
      mockCacheService.getCachedResponse.mockResolvedValue(null)

      // Arrange: Mock API success in fetchAndBuildResponse
      mockApiService.fetchPosts.mockResolvedValue(mockPost)

      // Arrange: Mock cache set in processRequest
      mockCacheService.setCache.mockResolvedValue(undefined)

      // Arrange: Mock invalidation (2 calls: tags + random)
      mockCacheService.invalidateCache
        .mockResolvedValueOnce(0) // tags
        .mockResolvedValueOnce(1) // random

      const result = await service.processRequest(jobId, query, clientId)

      // Act & Assert: Success response built correctly
      expect(result).toEqual({
        type: 'success',
        jobId,
        imageUrl: 'https://example.com/image.jpg',
        author: 'artist',
        tags: 'cat rating:safe',
        rating: 's',
        source: 'source',
        copyright: 'copyright',
        id: 1,
        characters: null,
      })

      // Assert: Rate limit checked

      expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
        'danbooru',
        jobId,
        clientId,
      )

      // Assert: Cache get called (in getOrFetchFromCache, defaults random=true, limit=1, tags=['cat'])

      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        true,
        1,
        ['cat'],
      )

      // Assert: API fetch called (in fetchAndBuildResponse)

      expect(mockApiService.fetchPosts).toHaveBeenCalledWith(query, 1, true)

      // Assert: Cache set called after fetch

      expect(mockCacheService.setCache).toHaveBeenCalledWith(
        'danbooru',
        query,
        result,
        true,
        1,
        ['cat'],
      )

      // Assert: Invalidation called twice

      expect(mockCacheService.invalidateCache).toHaveBeenCalledTimes(2)

      // Assert: Response published

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.any(String),
      )

      // Assert: Lock acquired and released
      expect(mockLockUtil.acquireLock).toHaveBeenCalledWith(
        lockKey,
        QUERY_LOCK_TIMEOUT_SECONDS,
      )
      expect(mockLockUtil.releaseLock).toHaveBeenCalledWith(
        lockKey,
        'lock-value',
      )
    })

    it('should return cached response when cache hit (random=true)', async () => {
      // Arrange: Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as const)

      // Arrange: Mock cache hit (getOrFetchFromCache returns cached)
      const cachedResponse = {
        type: 'success' as const,
        jobId: 'cached-job',
        imageUrl: 'https://cached.com/image.jpg',
        author: 'cached artist',
        tags: 'cached:tags',
        rating: 'q',
        source: 'cached source',
        copyright: 'cached copyright',
      }
      mockCacheService.getCachedResponse.mockResolvedValue(cachedResponse)

      // Arrange: Invalidation (always for freshness)
      mockCacheService.invalidateCache
        .mockResolvedValueOnce(0) // tags
        .mockResolvedValueOnce(1) // random

      const result = await service.processRequest(jobId, query, clientId)

      // Act & Assert
      expect(result).toEqual(cachedResponse)

      // Assert: Cache get called

      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        true,
        1,
        ['cat'],
      )

      // Assert: No API call

      expect(mockApiService.fetchPosts).not.toHaveBeenCalled()

      // Assert: No cache set (hit)

      expect(mockCacheService.setCache).not.toHaveBeenCalled()

      // Assert: Invalidation called (for freshness, even on hit)

      expect(mockCacheService.invalidateCache).toHaveBeenCalledTimes(2)

      // Assert: Published

      expect(mockRedis.xadd).toHaveBeenCalled()

      // Assert: Lock handled
      expect(mockLockUtil.acquireLock).toHaveBeenCalled()
      expect(mockLockUtil.releaseLock).toHaveBeenCalled()
    })

    it('should handle rate limit failure', async () => {
      // Arrange: Rate limit fail
      const rateError: RateLimitResult = {
        allowed: false,
        error: {
          type: 'error',
          jobId,
          error: 'Rate limited',
        } as DanbooruErrorResponse,
      }
      mockRateLimitManager.checkRateLimit.mockResolvedValue(rateError)

      // Act
      const result = await service.processRequest(jobId, query, clientId)

      // Assert: Error response from rate check
      expect(result).toEqual(rateError.error)

      // Assert: Lock acquired/released (early return after rate check)
      expect(mockLockUtil.acquireLock).toHaveBeenCalled()
      expect(mockLockUtil.releaseLock).toHaveBeenCalled()

      // Assert: No cache/API calls

      expect(mockCacheService.getCachedResponse).not.toHaveBeenCalled()

      expect(mockApiService.fetchPosts).not.toHaveBeenCalled()

      // For rate limit, no publish or DLQ - early return
    })

    it('should handle lock not acquired (duplicate)', async () => {
      // Arrange: Lock fail
      mockLockUtil.acquireLock.mockResolvedValue(null)

      // Act
      const result = await service.processRequest(jobId, query, clientId)

      // Assert: Duplicate error
      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'Query is currently being processed',
      })

      // Assert: No further calls

      expect(mockRateLimitManager.checkRateLimit).not.toHaveBeenCalled()

      expect(mockCacheService.getCachedResponse).not.toHaveBeenCalled()

      // Assert: Published

      expect(mockRedis.xadd).toHaveBeenCalled()

      // Assert: No release (no lock)
      expect(mockLockUtil.releaseLock).not.toHaveBeenCalled()
    })

    it('should handle API fetch failure', async () => {
      // Arrange: Rate ok, cache miss, API null
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as const)
      mockCacheService.getCachedResponse.mockResolvedValue(null)
      mockApiService.fetchPosts.mockResolvedValue(null)

      // Act
      const result = await service.processRequest(jobId, query, clientId)

      // Assert: Error from fetch
      expect(result).toEqual({
        type: 'error',
        jobId,
        error: 'No posts found for the query or API error',
      })

      // Assert: Cache get called

      expect(mockCacheService.getCachedResponse).toHaveBeenCalled()

      // Assert: API called

      expect(mockApiService.fetchPosts).toHaveBeenCalled()

      // Assert: No set/invalidation

      expect(mockCacheService.setCache).not.toHaveBeenCalled()

      expect(mockCacheService.invalidateCache).not.toHaveBeenCalled()

      // Assert: Published and DLQ

      expect(mockRedis.xadd).toHaveBeenCalled()
      expect(addToDLQ as jest.Mock).toHaveBeenCalled()

      // Assert: Lock handled
      expect(mockLockUtil.acquireLock).toHaveBeenCalled()
      expect(mockLockUtil.releaseLock).toHaveBeenCalled()
    })
  })
})
