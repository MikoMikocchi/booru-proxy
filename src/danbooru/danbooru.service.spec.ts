import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { LockUtil } from '../common/redis/utils/lock.util'

jest.mock('./danbooru-api.service')
jest.mock('../common/cache/cache.service')
jest.mock('../common/cache/cache-manager.service')
jest.mock('../common/rate-limit/rate-limit-manager.service')
jest.mock('ioredis')
jest.mock('crypto')
jest.mock('../common/redis/utils/lock.util')

const mockLockUtil = {
  acquireLock: jest.fn(),
  extendLock: jest.fn(),
  releaseLock: jest.fn(),
}

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

      // Mock LockUtil

      mockLockUtil.acquireLock.mockResolvedValue('lock-value')

      mockLockUtil.extendLock.mockResolvedValue(true)

      mockLockUtil.releaseLock.mockResolvedValue(true)

      // Mock Redis for lock

      mockRedis.set!.mockResolvedValue('OK')

      mockRedis.get!.mockResolvedValue(jobId)

      mockRedis.del!.mockResolvedValue(1)

      mockRedis.xadd!.mockResolvedValue('1')
    })

    it('should process request successfully with cache miss', async () => {
      // Mock rate limit success

      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as const)

      // Mock cache miss

      mockCacheService.getCachedResponse.mockResolvedValue(null)

      // Mock API success

      mockApiService.fetchPosts.mockResolvedValue(mockPost)

      const result = await service.processRequest(jobId, query, clientId)

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

      // Verify rate limit check

      expect(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        mockRateLimitManager.checkRateLimit as jest.Mock,
      ).toHaveBeenCalledWith('danbooru', jobId, clientId)

      // Verify cache miss - service uses random=true (default)

      expect(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        mockCacheService.getCachedResponse as jest.Mock,
      ).toHaveBeenCalledWith('danbooru', query, true, 1, ['cat'])

      // Verify API call with random=true (default)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockApiService.fetchPosts as jest.Mock).toHaveBeenCalledWith(
        query,
        1,
        true,
      )

      // Verify response published with timestamp

      expect(mockRedis.xadd as jest.Mock).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.any(String), // JSON string with result + timestamp
      )

      // Verify cache set with full signature and random=true
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockCacheService.setCache as jest.Mock).toHaveBeenCalledWith(
        'danbooru',
        query,
        result,
        true,
        1,
        ['cat'],
      )

      // Verify cache invalidation for random queries

      expect(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        mockCacheService.invalidateCache as jest.Mock,
      ).toHaveBeenCalledTimes(2)

      // Verify lock released

      expect(mockLockUtil.releaseLock).toHaveBeenCalledWith(lockKey, 'lock-value')
    })

    it('should return cached response when cache hit (random=true)', async () => {
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

      // Mock rate limit success

      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as const)

      // Mock cache hit

      mockCacheService.getCachedResponse.mockResolvedValue(cachedResponse)

      const result = await service.processRequest(jobId, query, clientId)

      expect(result).toEqual(cachedResponse)

      // Verify cache hit with service default random=true

      expect(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        mockCacheService.getCachedResponse as jest.Mock,
      ).toHaveBeenCalledWith('danbooru', query, true, 1, ['cat'])

      // Should not call API
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockApiService.fetchPosts).not.toHaveBeenCalled()

      // Lock should be released

      expect(mockLockUtil.releaseLock).toHaveBeenCalledWith(lockKey, 'lock-value')
    })
  })
})
