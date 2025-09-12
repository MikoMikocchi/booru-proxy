import { Test, TestingModule } from '@nestjs/testing'
import { CacheService, CacheableResponse } from './cache.service'
import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'

jest.mock('ioredis')
const RedisMock = require('ioredis')

describe('CacheService', () => {
  let service: CacheService
  let mockRedis: jest.Mocked<any>
  let configService: jest.Mocked<ConfigService>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      ping: jest.fn().mockResolvedValue('PONG'),
      pipeline: jest.fn().mockReturnValue({
        del: jest.fn().mockReturnThis(),
        exec: jest.fn(),
      }),
    } as any

    configService = {
      get: jest.fn(),
    } as any

    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any

    // Mock Redis instance
    RedisMock.default.mockImplementation(() => mockRedis)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: 'CACHE_BACKEND',
          useValue: {
            get: mockRedis.get,
            setex: mockRedis.setex,
            del: mockRedis.del,
            keys: mockRedis.keys,
            pipeline: mockRedis.pipeline,
            invalidate: jest.fn().mockResolvedValue(0),
            getStats: jest.fn().mockResolvedValue({ hit: 0, miss: 0 }),
          },
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: Logger,
          useValue: mockLogger,
        },
        CacheService,
      ],
    }).compile()

    service = module.get<CacheService>(CacheService)
    configService.get.mockReturnValue(3600)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('getCachedResponse', () => {
    it('should return parsed cached data on hit', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const mockData: CacheableResponse = { posts: [{ id: 1, tags: ['cat'] }] }
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'
      const cachedString = JSON.stringify(mockData)

      ;(service as any).backend.get.mockResolvedValueOnce(cachedString)

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect((service as any).backend.get).toHaveBeenCalledWith(cacheKey)
      expect(result).toEqual(mockData)
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('should return null on cache miss', async () => {
      const apiPrefix = 'danbooru'
      const query = 'dog'
      const random = false
      const cacheKey = 'cache:danbooru:posts:06d80eb0c50b39939cb9c12a98c8034e'

      ;(service as any).backend.get.mockResolvedValueOnce(null)

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect((service as any).backend.get).toHaveBeenCalledWith(cacheKey)
      expect(result).toBeNull()
    })

    it('should clean invalid JSON cache and return null', async () => {
      const apiPrefix = 'danbooru'
      const query = 'invalid'
      const random = false
      const cacheKey = 'cache:danbooru:posts:5f4dcc3b5aa765d61d8327deb882cf99'
      const invalidJson = 'invalid json data'

      ;(service as any).backend.get.mockResolvedValueOnce(invalidJson)
      ;(service as any).backend.del.mockResolvedValueOnce(undefined)

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect((service as any).backend.get).toHaveBeenCalledWith(cacheKey)
      expect((service as any).backend.del).toHaveBeenCalledWith(cacheKey)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse cached data'),
      )
      expect(result).toBeNull()
    })
  })

  describe('setCache', () => {
    it('should cache data with default TTL', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const mockData: CacheableResponse = { posts: [{ id: 1 }] }
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'

      await service.setCache(apiPrefix, query, mockData, random)

      expect((service as any).backend.setex).toHaveBeenCalledWith(
        cacheKey,
        3600,
        mockData,
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cached response for danbooru'),
      )
    })

    it('should use custom TTL when provided', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const mockData: CacheableResponse = { posts: [{ id: 1 }] }
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'
      const customTtl = 1800

      await service.setCache(apiPrefix, query, mockData, random, undefined, undefined, customTtl)

      expect((service as any).backend.setex).toHaveBeenCalledWith(
        cacheKey,
        customTtl,
        mockData,
      )
    })
  })

  describe('deleteCache', () => {
    it('should delete cache entry', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'

      await service.deleteCache(apiPrefix, query, random)

      expect((service as any).backend.del).toHaveBeenCalledWith(cacheKey)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deleted cache for danbooru'),
      )
    })
  })

  describe('getOrSet', () => {
    it('should return cached data when available', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const mockData: CacheableResponse = { posts: [{ id: 1 }] }
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'
      const cachedString = JSON.stringify(mockData)

      ;(service as any).backend.get.mockResolvedValueOnce(cachedString)
      const fetchFn = jest.fn().mockResolvedValue(null)

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn)

      expect(result).toEqual(mockData)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('should fetch and cache new data on miss', async () => {
      const apiPrefix = 'danbooru'
      const query = 'dog'
      const random = false
      const freshData: CacheableResponse = { posts: [{ id: 2 }] }
      const cacheKey = 'cache:danbooru:posts:06d80eb0c50b39939cb9c12a98c8034e'

      ;(service as any).backend.get.mockResolvedValueOnce(null)
      const fetchFn = jest.fn().mockResolvedValue(freshData)

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn)

      expect((service as any).backend.get).toHaveBeenCalledWith(cacheKey)
      expect((service as any).backend.setex).toHaveBeenCalledWith(
        cacheKey,
        3600,
        freshData,
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(freshData)
    })

    it('should return null when fetch returns null', async () => {
      const apiPrefix = 'danbooru'
      const query = 'empty'
      const random = false
      const cacheKey = 'cache:danbooru:posts:73c3b6b8f4e5a7d2c9e8f1a3b2c4d5e6'

      ;(service as any).backend.get.mockResolvedValueOnce(null)
      const fetchFn = jest.fn().mockResolvedValue(null)

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn)

      expect(result).toBeNull()
      expect((service as any).backend.setex).not.toHaveBeenCalled()
    })
  })

  describe('getCacheKey', () => {
    it('should generate consistent key for same inputs', () => {
      const apiPrefix = 'danbooru'
      const query = 'cat dog'
      const random = false

      const key1 = (service as any).getCacheKey(apiPrefix, query, random)
      const key2 = (service as any).getCacheKey(apiPrefix, query, random)

      expect(key1).toBe(key2)
      expect(key1).toMatch(/^cache:danbooru:posts:[a-f0-9]{32}$/)
    })

    it('should normalize query string', () => {
      const apiPrefix = 'danbooru'
      const query1 = '  Cat   Dog  '
      const query2 = 'cat dog'
      const random = false

      const key1 = (service as any).getCacheKey(apiPrefix, query1, random)
      const key2 = (service as any).getCacheKey(apiPrefix, query2, random)

      expect(key1).toBe(key2)
    })

    it('should include limit in key when provided', () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false

      const keyWithLimit = (service as any).getCacheKey(apiPrefix, query, random, 50)
      const keyWithoutLimit = (service as any).getCacheKey(apiPrefix, query, random)

      expect(keyWithLimit).not.toBe(keyWithoutLimit)
      expect(keyWithLimit).toContain('limit:50')
    })

    it('should include tags in key when provided', () => {
      const apiPrefix = 'danbooru'
      const query = 'posts'
      const random = false
      const tags = ['cat', 'dog']

      const keyWithTags = (service as any).getCacheKey(apiPrefix, query, random, undefined, tags)
      const keyWithoutTags = (service as any).getCacheKey(apiPrefix, query, random)

      expect(keyWithTags).not.toBe(keyWithoutTags)
      expect(keyWithTags).toContain('tag:')
    })
  })

  describe('invalidateByPrefix', () => {
    it('should invalidate all keys for API prefix', async () => {
      const pattern = 'cache:danbooru:*'
      ;(service as any).backend.invalidate.mockResolvedValueOnce(5)

      const result = await service.invalidateByPrefix('danbooru')

      expect((service as any).backend.invalidate).toHaveBeenCalledWith(pattern)
      expect(result).toBe(5)
    })

    it('should handle invalidation errors', async () => {
      const pattern = 'cache:gelbooru:*'
      const error = new Error('Redis error')
      ;(service as any).backend.invalidate.mockRejectedValueOnce(error)

      const result = await service.invalidateByPrefix('gelbooru')

      expect((service as any).backend.invalidate).toHaveBeenCalledWith(pattern)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to invalidate cache'),
      )
      expect(result).toBe(0)
    })
  })

  describe('getOrFetch', () => {
    it('should return cached data on hit', async () => {
      const key = 'test:cache:key'
      const mockData = { value: 'cached' }
      const cachedString = JSON.stringify(mockData)

      ;(service as any).get.mockResolvedValueOnce(cachedString)
      const fetchFn = jest.fn()

      const result = await service.getOrFetch(key, fetchFn)

      expect(result).toEqual(mockData)
      expect(fetchFn).not.toHaveBeenCalled()
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache hit'))
    })

    it('should fetch and cache on miss', async () => {
      const key = 'test:cache:miss'
      const freshData = { value: 'fresh' }

      ;(service as any).get.mockResolvedValueOnce(null)
      const fetchFn = jest.fn().mockResolvedValue(freshData)

      const result = await service.getOrFetch(key, fetchFn)

      expect((service as any).get).toHaveBeenCalledWith(key)
      expect((service as any).setex).toHaveBeenCalledWith(key, 3600, JSON.stringify(freshData))
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache miss'))
      expect(result).toEqual(freshData)
    })

    it('should refetch on invalid cached data', async () => {
      const key = 'test:invalid:cache'
      const invalidData = 'not json'
      const freshData = { value: 'fresh' }

      ;(service as any).get
        .mockResolvedValueOnce(invalidData)
        .mockResolvedValueOnce(null)
      ;(service as any).del.mockResolvedValueOnce(undefined)
      const fetchFn = jest.fn().mockResolvedValue(freshData)

      const result = await service.getOrFetch(key, fetchFn)

      expect((service as any).get).toHaveBeenCalledTimes(2)
      expect((service as any).del).toHaveBeenCalledWith(key)
      expect((service as any).setex).toHaveBeenCalledWith(key, 3600, JSON.stringify(freshData))
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid cached data'))
      expect(result).toEqual(freshData)
    })
  })

  describe('Multi-Backend Switching', () => {
    beforeEach(() => {
      // Mock different backends
      const mockMemcachedBackend = {
        get: jest.fn(),
        setex: jest.fn(),
        del: jest.fn(),
        invalidate: jest.fn().mockResolvedValue(0), // Memcached doesn't support patterns
        getStats: jest.fn().mockResolvedValue({}),
      }

      // Switch to Memcached backend for these tests
      ;(service as any).backend = mockMemcachedBackend
    })

    it('should use Memcached backend when configured', async () => {
      const apiPrefix = 'danbooru'
      const query = 'cat'
      const random = false
      const mockData: CacheableResponse = { posts: [{ id: 1 }] }
      const cacheKey = 'cache:danbooru:posts:9a0364b9e99bb480dd25e1f0280a8e9f'

      // Configure for Memcached
      configService.get.mockReturnValueOnce('memcached')

      const memcachedModule: TestingModule = await Test.createTestingModule({
        providers: [
          {
            provide: 'CACHE_BACKEND',
            useValue: {
              get: jest.fn(),
              setex: jest.fn(),
              del: jest.fn(),
              invalidate: jest.fn().mockResolvedValue(0),
              getStats: jest.fn().mockResolvedValue({}),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: Logger, useValue: mockLogger },
          CacheService,
        ],
      }).compile()

      const memcachedService = memcachedModule.get<CacheService>(CacheService)
      ;(memcachedService as any).backend.get.mockResolvedValueOnce(mockData)

      const result = await memcachedService.getCachedResponse(apiPrefix, query, random)

      expect((memcachedService as any).backend.get).toHaveBeenCalledWith(cacheKey)
      expect(result).toEqual(mockData)
    })

    it('should fallback to Redis for pattern invalidation with Memcached', async () => {
      const pattern = 'cache:danbooru:*'

      // Memcached returns 0 for pattern invalidation (no pattern support)
      ;(service as any).backend.invalidate.mockResolvedValueOnce(0)

      const result = await service.invalidateCache(pattern)

      expect(result).toBe(0)
      expect((service as any).backend.invalidate).toHaveBeenCalledWith(pattern)
      expect(mockLogger.error).not.toHaveBeenCalled()
    })
  })

  describe('CacheManager Generics', () => {
    it('should handle generic cache operations with apiPrefix', async () => {
      const apiPrefix = 'gelbooru'
      const query = 'anime'
      const random = true
      const limit = 20
      const tags = ['safe', 'anime']
      const mockData: CacheableResponse = {
        posts: [{ id: 1, score: 100, tags: tags }]
      }
      const cacheKey = expect.stringMatching(
        /^cache:gelbooru:posts:[a-f0-9]{32}:limit:20:random-seed:[a-f0-9]{16}:tag:[a-f0-9]{32}$/
      )

      ;(service as any).backend.get.mockResolvedValueOnce(JSON.stringify(mockData))

      const result = await service.getCachedResponse<CacheableResponse>(
        apiPrefix,
        query,
        random,
        limit,
        tags
      )

      expect((service as any).backend.get).toHaveBeenCalledWith(expect.stringMatching(cacheKey))
      expect(result).toEqual(mockData)
      expect(result?.posts?.[0].tags).toEqual(expect.arrayContaining(tags))
    })
  })
})
