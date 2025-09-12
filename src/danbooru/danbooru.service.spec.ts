import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from '../common/cache/cache.service'
import { CacheManagerService } from '../common/cache/cache-manager.service'
import { RateLimitManagerService } from '../common/rate-limit/rate-limit-manager.service'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import * as dlqUtil from '../common/queues/utils/dlq.util'
import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'

jest.mock('./danbooru-api.service')
jest.mock('../common/cache/cache.service')
jest.mock('../common/cache/cache-manager.service')
jest.mock('../common/rate-limit/rate-limit-manager.service')
jest.mock('../common/queues/utils/dlq.util')
jest.mock('ioredis')
jest.mock('crypto')

const mockDanbooruApiService = jest.mocked(DanbooruApiService)
const mockCacheService = jest.mocked(CacheService)
const mockRateLimitManager = jest.mocked(RateLimitManagerService)
const mockAddToDLQ = jest.mocked(dlqUtil.addToDLQ)
const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  xadd: jest.fn(),
} as any
const mockCacheManagerService = {
  get: jest.fn(),
} as any

interface MockDanbooruApiService {
  fetchPosts: jest.MockedFunction<any>
}

interface MockCacheService {
  getCachedResponse: jest.MockedFunction<any>
  setCache: jest.MockedFunction<any>
}

interface MockRateLimitManager {
  checkRateLimit: jest.MockedFunction<any>
}

describe('DanbooruService', () => {
  let service: DanbooruService
  let mockApiService: MockDanbooruApiService
  let mockCacheService: MockCacheService
  let mockRateLimitManager: MockRateLimitManager
  let mockConfigService: jest.Mocked<ConfigService>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    mockApiService = {
      fetchPosts: jest.fn(),
    }

    mockCacheService = {
      getCachedResponse: jest.fn(),
      setCache: jest.fn(),
    }

    mockRateLimitManager = {
      checkRateLimit: jest.fn(),
    }

    mockConfigService = {
      get: jest.fn(),
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
        DanbooruService,
        { provide: DanbooruApiService, useValue: mockApiService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: CacheManagerService, useValue: mockCacheManagerService },
        { provide: RateLimitManagerService, useValue: mockRateLimitManager },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: Logger, useValue: mockLogger },
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
      ;(
        crypto.createHash as jest.MockedFunction<typeof crypto.createHash>
      ).mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue('test-query-hash'),
          }) as any,
      )

      // Mock Redis for lock
      mockRedis.set.mockResolvedValue('OK')
      mockRedis.get.mockResolvedValue(jobId)
      mockRedis.del.mockResolvedValue(1)
      mockRedis.xadd.mockResolvedValue('1')
    })

    it('should process request successfully with cache miss', async () => {
      // Mock rate limit success
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any)

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
      })

      // Verify rate limit check
      expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
        'danbooru',
        jobId,
        clientId,
      )

      // Verify cache miss
      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        false,
      )

      // Verify API call
      expect(mockApiService.fetchPosts).toHaveBeenCalledWith(query, 1, false)

      // Verify response published
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'danbooru:responses',
        '*',
        'jobId',
        jobId,
        'data',
        expect.stringContaining(JSON.stringify(result)),
      )

      // Verify cache set
      expect(mockCacheService.setCache).toHaveBeenCalledWith(
        'danbooru',
        query,
        result,
        false,
      )

      // Verify lock released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey)
    })

    it('should return cached response when cache hit (random=false)', async () => {
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
      } as any)

      // Mock cache hit
      mockConfigService.get.mockReturnValueOnce(false) // DANBOORU_RANDOM = false
      mockCacheService.getCachedResponse.mockResolvedValue(cachedResponse)

      const result = await service.processRequest(jobId, query, clientId)

      expect(result).toEqual(cachedResponse)

      // Verify cache hit
      expect(mockCacheService.getCachedResponse).toHaveBeenCalledWith(
        'danbooru',
        query,
        false,
      )

      // Should not call API
      expect(mockApiService.fetchPosts).not.toHaveBeenCalled()

      // Lock should be released
      expect(mockRedis.del).toHaveBeenCalledWith(lockKey)
    })
  })
})
