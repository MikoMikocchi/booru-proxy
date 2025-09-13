import { Test, TestingModule } from '@nestjs/testing'
import { CacheService, type CacheableResponse } from './cache.service'
import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'
import type { ICacheBackend } from './interfaces/icache-backend.interface'
import * as crypto from 'crypto'

type MockedBackend = {
  [K in keyof ICacheBackend]: jest.MockedFunction<ICacheBackend[K]>
}

type MockedLogger = jest.Mocked<Logger>
type MockedConfigGet = jest.MockedFunction<ConfigService['get']>

describe('CacheService', () => {
  let service: CacheService
  let mockConfigService: { get: MockedConfigGet }
  let mockBackend: MockedBackend
  let mockLogger: MockedLogger

  // Extracted mock functions for backend
  let mockGet: jest.Mock
  let mockSetex: jest.Mock
  let mockDel: jest.Mock
  let mockInvalidate: jest.Mock
  let mockGetStats: jest.Mock

  // Extracted mock functions for logger (not used for expects, but provided)
  let mockLog: jest.Mock
  let mockError: jest.Mock
  let mockWarn: jest.Mock
  let mockDebug: jest.Mock
  let mockVerbose: jest.Mock

  const mockTtl = 3600
  const defaultApiPrefix = 'danbooru'
  const defaultQuery = 'cat'
  const normalizedQueryHash = 'd077f244def8a70e5ea758bd8352fcd8' // MD5 of 'cat'
  const defaultCacheKey = `cache:${defaultApiPrefix}:posts:${normalizedQueryHash}`

  beforeEach(async () => {
    mockGet = jest.fn()
    mockSetex = jest.fn()
    mockDel = jest.fn()
    mockInvalidate = jest.fn()
    mockGetStats = jest.fn()

    mockBackend = {
      get: mockGet,
      setex: mockSetex,
      del: mockDel,
      invalidate: mockInvalidate,
      getStats: mockGetStats,
    }

    mockConfigService = {
      get: jest.fn().mockReturnValue(mockTtl),
    }

    mockLog = jest.fn()
    mockError = jest.fn()
    mockWarn = jest.fn()
    mockDebug = jest.fn()
    mockVerbose = jest.fn()

    mockLogger = {
      log: mockLog,
      error: mockError,
      warn: mockWarn,
      debug: mockDebug,
      verbose: mockVerbose,
    } as unknown as MockedLogger

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheService,
        {
          provide: 'CACHE_BACKEND',
          useValue: mockBackend,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: Logger,
          useValue: mockLogger,
        },
      ],
    }).compile()

    service = module.get(CacheService)
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('getCachedResponse', () => {
    const mockData: CacheableResponse = { posts: [{ id: 1, tags: ['cat'] }] }

    it('should return parsed data on cache hit without limit or tags', async () => {
      mockGet.mockResolvedValueOnce(mockData)

      const result = await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
      )

      expect(mockGet).toHaveBeenCalledWith(defaultCacheKey)
      expect(result).toEqual(mockData)
    })

    it('should return null on cache miss', async () => {
      mockGet.mockResolvedValueOnce(null)

      const result = await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
      )

      expect(mockGet).toHaveBeenCalledWith(defaultCacheKey)
      expect(result).toBeNull()
    })

    it('should include limit in key', async () => {
      const limit = 20
      const keyWithLimit = `${defaultCacheKey}:limit:${limit}`

      mockGet.mockResolvedValueOnce(mockData)

      await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        limit,
      )

      expect(mockGet).toHaveBeenCalledWith(keyWithLimit)
    })

    it('should include tags hash in key', async () => {
      const tags = ['cat', 'dog']
      const sortedTags = tags.sort().join(',')
      const tagHash = crypto.createHash('md5').update(sortedTags).digest('hex')
      const keyWithTags = `${defaultCacheKey}:tag:${tagHash}`

      mockGet.mockResolvedValueOnce(mockData)

      await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        undefined,
        tags,
      )

      expect(mockGet).toHaveBeenCalledWith(keyWithTags)
    })

    it('should include random seed in key', async () => {
      const query = 'random query'
      const limit = 10
      const tags = ['tag1']
      const seedParts = [
        query.trim(),
        limit?.toString() || 'default',
        tags.sort().join(',') || 'no-tags',
      ]
      const seedString = seedParts.join('|')
      const seed = crypto
        .createHash('sha256')
        .update(seedString)
        .digest('hex')
        .slice(0, 16)
      const normalizedQuery = query
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
      const queryHash = crypto
        .createHash('md5')
        .update(normalizedQuery)
        .digest('hex')
      const baseKey = `cache:${defaultApiPrefix}:posts:${queryHash}`
      const tagHash = crypto.createHash('md5').update('tag1').digest('hex')
      const keyWithRandom = `${baseKey}:limit:${limit}:seed:${seed}:tag:${tagHash}`

      mockGet.mockResolvedValueOnce(mockData)

      await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        query,
        true,
        limit,
        tags,
      )

      expect(mockGet).toHaveBeenCalledWith(keyWithRandom)
    })

    it('should normalize query for key generation', async () => {
      const messyQuery = '  Cat   Dog  '
      const normalized = 'cat dog'
      const normalizedHash = crypto
        .createHash('md5')
        .update(normalized)
        .digest('hex')
      const expectedKey = `cache:${defaultApiPrefix}:posts:${normalizedHash}`

      mockGet.mockResolvedValueOnce(mockData)

      await service.getCachedResponse<CacheableResponse>(
        defaultApiPrefix,
        messyQuery,
        false,
      )

      expect(mockGet).toHaveBeenCalledWith(expectedKey)
    })
  })

  describe('setCache', () => {
    const mockData: CacheableResponse = { posts: [{ id: 1 }] }

    it('should set cache with default TTL without limit or tags', async () => {
      await service.setCache(defaultApiPrefix, defaultQuery, mockData, false)

      expect(mockSetex).toHaveBeenCalledWith(defaultCacheKey, mockTtl, mockData)
    })

    it('should use custom TTL', async () => {
      const customTtl = 1800

      await service.setCache(
        defaultApiPrefix,
        defaultQuery,
        mockData,
        false,
        undefined,
        undefined,
        customTtl,
      )

      expect(mockSetex).toHaveBeenCalledWith(
        defaultCacheKey,
        customTtl,
        mockData,
      )
    })

    it('should include limit and tags in key', async () => {
      const limit = 20
      const tags = ['cat']
      const sortedTags = tags.sort().join(',')
      const tagHash = crypto.createHash('md5').update(sortedTags).digest('hex')
      const keyWithParams = `${defaultCacheKey}:limit:${limit}:tag:${tagHash}`

      await service.setCache(
        defaultApiPrefix,
        defaultQuery,
        mockData,
        false,
        limit,
        tags,
      )

      expect(mockSetex).toHaveBeenCalledWith(keyWithParams, mockTtl, mockData)
    })

    it('should handle backend setex error', async () => {
      const error = new Error('Setex failed')
      mockSetex.mockRejectedValueOnce(error)

      await expect(
        service.setCache(defaultApiPrefix, defaultQuery, mockData, false),
      ).rejects.toThrow('Setex failed')
    })
  })

  describe('deleteCache', () => {
    it('should delete specific cache entry', async () => {
      await service.deleteCache(defaultApiPrefix, defaultQuery, false)

      expect(mockDel).toHaveBeenCalledWith(defaultCacheKey)
    })

    it('should include params in key for deletion', async () => {
      const limit = 10
      const tags = ['tag']
      const sortedTags = tags.sort().join(',')
      const tagHash = crypto.createHash('md5').update(sortedTags).digest('hex')
      const keyWithParams = `${defaultCacheKey}:limit:${limit}:tag:${tagHash}`

      await service.deleteCache(
        defaultApiPrefix,
        defaultQuery,
        false,
        limit,
        tags,
      )

      expect(mockDel).toHaveBeenCalledWith(keyWithParams)
    })

    it('should handle backend del error', async () => {
      const error = new Error('Delete failed')
      mockDel.mockRejectedValueOnce(error)

      await expect(
        service.deleteCache(defaultApiPrefix, defaultQuery, false),
      ).rejects.toThrow('Delete failed')
    })
  })

  describe('getOrSet', () => {
    it('should return cached data without calling fetchFn', async () => {
      const fetchFn = jest.fn()
      const cachedData: CacheableResponse = { posts: [{ id: 1 }] }
      mockGet.mockResolvedValueOnce(cachedData)

      const result = await service.getOrSet<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        fetchFn,
      )

      expect(result).toEqual(cachedData)
      expect(fetchFn).not.toHaveBeenCalled()
      expect(mockSetex).not.toHaveBeenCalled()
    })

    it('should fetch, cache, and return data on miss', async () => {
      const fetchFn = jest.fn()
      const freshData: CacheableResponse = { posts: [{ id: 2 }] }
      fetchFn.mockResolvedValueOnce(freshData)
      mockGet.mockResolvedValueOnce(null)

      const result = await service.getOrSet<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        fetchFn,
      )

      expect(mockGet).toHaveBeenCalledWith(defaultCacheKey)
      expect(mockSetex).toHaveBeenCalledWith(
        defaultCacheKey,
        mockTtl,
        freshData,
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(freshData)
    })

    it('should return null if fetchFn returns null', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce(null)
      mockGet.mockResolvedValueOnce(null)

      const result = await service.getOrSet<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        fetchFn,
      )

      expect(result).toBeNull()
      expect(mockSetex).not.toHaveBeenCalled()
    })

    it('should use custom TTL', async () => {
      const fetchFn = jest.fn()
      const customTtl = 7200
      const freshData: CacheableResponse = { posts: [{ id: 3 }] }
      fetchFn.mockResolvedValueOnce(freshData)
      mockGet.mockResolvedValueOnce(null)

      await service.getOrSet<CacheableResponse>(
        defaultApiPrefix,
        defaultQuery,
        false,
        fetchFn,
        undefined,
        undefined,
        customTtl,
      )

      expect(mockSetex).toHaveBeenCalledWith(
        defaultCacheKey,
        customTtl,
        freshData,
      )
    })

    it('should handle fetchFn error', async () => {
      const fetchFn = jest.fn()
      const error = new Error('Fetch failed')
      fetchFn.mockRejectedValueOnce(error)
      mockGet.mockResolvedValueOnce(null)

      await expect(
        service.getOrSet<CacheableResponse>(
          defaultApiPrefix,
          defaultQuery,
          false,
          fetchFn,
        ),
      ).rejects.toThrow('Fetch failed')
    })
  })

  describe('invalidateCache', () => {
    it('should delegate to backend and return count', async () => {
      const pattern = 'cache:danbooru:*'
      const deletedCount = 5
      mockInvalidate.mockResolvedValueOnce(deletedCount)

      const result = await service.invalidateCache(pattern)

      expect(mockInvalidate).toHaveBeenCalledWith(pattern)
      expect(result).toBe(deletedCount)
    })

    it('should handle backend error', async () => {
      const pattern = 'cache:error:*'
      const error = new Error('Invalidate failed')
      mockInvalidate.mockRejectedValueOnce(error)

      const result = await service.invalidateCache(pattern)

      expect(mockInvalidate).toHaveBeenCalledWith(pattern)
      expect(result).toBe(0)
    })
  })

  describe('invalidateByPrefix', () => {
    it('should invalidate by prefix pattern', async () => {
      const apiPrefix = 'danbooru'
      const pattern = `cache:${apiPrefix}:*`
      const deletedCount = 3
      mockInvalidate.mockResolvedValueOnce(deletedCount)

      const result = await service.invalidateByPrefix(apiPrefix)

      expect(mockInvalidate).toHaveBeenCalledWith(pattern)
      expect(result).toBe(deletedCount)
    })
  })

  describe('invalidate', () => {
    it('should invalidate all keys if no pattern', async () => {
      const deletedCount = 10
      mockInvalidate.mockResolvedValueOnce(deletedCount)

      const result = await service.invalidate()

      expect(mockInvalidate).toHaveBeenCalledWith(undefined)
      expect(result).toBe(deletedCount)
    })

    it('should invalidate by pattern', async () => {
      const pattern = '*'
      const deletedCount = 7
      mockInvalidate.mockResolvedValueOnce(deletedCount)

      const result = await service.invalidate(pattern)

      expect(mockInvalidate).toHaveBeenCalledWith(pattern)
      expect(result).toBe(deletedCount)
    })

    it('should handle error', async () => {
      const error = new Error('Invalidate error')
      mockInvalidate.mockRejectedValueOnce(error)

      await expect(service.invalidate()).rejects.toThrow('Invalidate error')
    })
  })

  describe('getStats', () => {
    it('should return backend stats', async () => {
      const mockStats = { hits: 100, misses: 50, size: 1024 }
      mockGetStats.mockResolvedValueOnce(mockStats)

      const result = await service.getStats()

      expect(mockGetStats).toHaveBeenCalledTimes(1)
      expect(result).toEqual(mockStats)
    })

    it('should return empty on error', async () => {
      const error = new Error('Stats error')
      mockGetStats.mockRejectedValueOnce(error)

      const result = await service.getStats()

      expect(result).toEqual({})
    })
  })

  describe('getOrFetch', () => {
    it('should return cached data on hit', async () => {
      const fetchFn = jest.fn()
      const key = 'test:key'
      const cachedData = { value: 'cached' }
      mockGet.mockResolvedValueOnce(cachedData)

      const result = await service.getOrFetch(key, fetchFn)

      expect(result).toEqual(cachedData)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('should fetch and cache on miss', async () => {
      const fetchFn = jest.fn()
      const key = 'test:miss'
      const freshData = { value: 'fresh' }
      fetchFn.mockResolvedValueOnce(freshData)
      mockGet.mockResolvedValueOnce(null)

      const result = await service.getOrFetch(key, fetchFn)

      expect(mockGet).toHaveBeenCalledWith(key)
      expect(mockSetex).toHaveBeenCalledWith(key, mockTtl, freshData)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(freshData)
    })

    it('should use custom TTL', async () => {
      const fetchFn = jest.fn()
      const key = 'test:ttl'
      const customTtl = 300
      const freshData = { value: 'custom' }
      fetchFn.mockResolvedValueOnce(freshData)
      mockGet.mockResolvedValueOnce(null)

      await service.getOrFetch(key, fetchFn, customTtl)

      expect(mockSetex).toHaveBeenCalledWith(key, customTtl, freshData)
    })

    it('should propagate fetchFn error', async () => {
      const fetchFn = jest.fn()
      const key = 'test:error'
      const error = new Error('Fetch error')
      fetchFn.mockRejectedValueOnce(error)
      mockGet.mockResolvedValueOnce(null)

      await expect(service.getOrFetch(key, fetchFn)).rejects.toThrow(
        'Fetch error',
      )
    })
  })
})
