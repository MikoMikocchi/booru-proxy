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
          provide: 'REDIS_CLIENT',
          useValue: mockRedis,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile()

    service = module.get<CacheService>(CacheService)

    // Setup config defaults
    configService.get
      .mockReturnValueOnce('redis') // CACHE_BACKEND
      .mockReturnValueOnce(3600) // CACHE_TTL_SECONDS
      .mockReturnValue('danbooru') // For constants in getCacheKey
      .mockReturnValue('posts') // For constants in getCacheKey
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  describe('getOrFetch', () => {
    const key = 'cache:test-hash'
    const data = { id: 1, value: 'test' }
    const fetchProvider = jest.fn().mockResolvedValue(data)

    it('should return cached data on hit', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data))

      const result = await service.getOrFetch(key, fetchProvider, 3600)

      expect(result).toEqual(data)
      expect(mockRedis.get).toHaveBeenCalledWith(key)
      expect(fetchProvider).not.toHaveBeenCalled()
      expect(mockLogger.debug).toHaveBeenCalledWith(`Cache hit for key: ${key}`)
    })

    it('should fetch and cache data on miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      mockRedis.setex.mockResolvedValueOnce(undefined)

      const result = await service.getOrFetch(key, fetchProvider, 3600)

      expect(result).toEqual(data)
      expect(mockRedis.get).toHaveBeenCalledWith(key)
      expect(fetchProvider).toHaveBeenCalledTimes(1)
      expect(mockRedis.setex).toHaveBeenCalledWith(
        key,
        3600,
        JSON.stringify(data),
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Cache miss for key: ${key}, fetching data`,
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Cached fresh data for key: ${key} with TTL: 3600s`,
      )
    })

    it('should handle invalid cached JSON and refetch', async () => {
      mockRedis.get.mockResolvedValueOnce('invalid-json')
      mockRedis.del.mockResolvedValueOnce(1)
      mockRedis.setex.mockResolvedValueOnce(undefined)

      const result = await service.getOrFetch(key, fetchProvider, 3600)

      expect(result).toEqual(data)
      expect(mockRedis.del).toHaveBeenCalledWith(key)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Invalid cached data for key ${key}, fetching fresh`,
      )
      expect(fetchProvider).toHaveBeenCalledTimes(1)
    })

    it('should use default TTL when not provided', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      mockRedis.setex.mockResolvedValueOnce(undefined)

      await service.getOrFetch(key, fetchProvider)

      expect(mockRedis.setex).toHaveBeenCalledWith(
        key,
        3600,
        expect.any(String),
      )
    })

    it('should handle fetch provider throwing error', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      const error = new Error('Fetch failed')
      fetchProvider.mockRejectedValueOnce(error)

      await expect(
        service.getOrFetch(key, fetchProvider, 3600),
      ).rejects.toThrow('Fetch failed')
      expect(mockRedis.setex).not.toHaveBeenCalled()
    })
  })

  describe('getCachedResponse', () => {
    const apiPrefix = 'posts'
    const query = 'tags:cat rating:safe'
    const random = false
    const data = { posts: [{ id: 1 }] }

    beforeEach(() => {
      // Mock getCacheKey to return consistent key
      jest
        .spyOn(service as any, 'getCacheKey')
        .mockReturnValue('cache:test-key')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should return parsed cached response', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data))

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect(result).toEqual(data)
      expect(mockRedis.get).toHaveBeenCalledWith('cache:test-key')
    })

    it('should return null on cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null)

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect(result).toBeNull()
    })

    it('should clean invalid cache on parse error', async () => {
      mockRedis.get.mockResolvedValueOnce('invalid-json')
      mockRedis.del.mockResolvedValueOnce(1)

      const result = await service.getCachedResponse(apiPrefix, query, random)

      expect(result).toBeNull()
      expect(mockRedis.del).toHaveBeenCalledWith('cache:test-key')
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse cached data'),
      )
    })
  })

  describe('setCache', () => {
    const apiPrefix = 'posts'
    const query = 'tags:cat'
    const response = { posts: [{ id: 1 }] }
    const random = false

    beforeEach(() => {
      jest
        .spyOn(service as any, 'getCacheKey')
        .mockReturnValue('cache:test-key')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should cache response with default TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce(undefined)

      await service.setCache(apiPrefix, query, response, random)

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'cache:test-key',
        3600,
        JSON.stringify(response),
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cached response'),
      )
    })

    it('should cache response with custom TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce(undefined)

      await service.setCache(apiPrefix, query, response, random, 1800)

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'cache:test-key',
        1800,
        JSON.stringify(response),
      )
    })
  })

  describe('deleteCache', () => {
    const apiPrefix = 'posts'
    const query = 'tags:cat'
    const random = false

    beforeEach(() => {
      jest
        .spyOn(service as any, 'getCacheKey')
        .mockReturnValue('cache:test-key')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should delete cache entry', async () => {
      mockRedis.del.mockResolvedValueOnce(1)

      await service.deleteCache(apiPrefix, query, random)

      expect(mockRedis.del).toHaveBeenCalledWith('cache:test-key')
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deleted cache'),
      )
    })
  })

  describe('getOrSet', () => {
    const apiPrefix = 'posts'
    const query = 'tags:cat'
    const random = false
    const data = { posts: [{ id: 1 }] }
    const fetchFn = jest.fn().mockResolvedValue(data)

    beforeEach(() => {
      jest
        .spyOn(service as any, 'getCacheKey')
        .mockReturnValue('cache:test-key')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should return cached data without calling fetchFn', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data))

      const result = await service.getOrSet(
        apiPrefix,
        query,
        random,
        fetchFn,
        3600,
      )

      expect(result).toEqual(data)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('should fetch and cache on miss, then return data', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      mockRedis.setex.mockResolvedValueOnce(undefined)

      const result = await service.getOrSet(
        apiPrefix,
        query,
        random,
        fetchFn,
        1800,
      )

      expect(result).toEqual(data)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'cache:test-key',
        1800,
        JSON.stringify(data),
      )
    })

    it('should handle null from fetchFn', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      fetchFn.mockResolvedValueOnce(null)

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn)

      expect(result).toBeNull()
      expect(mockRedis.setex).not.toHaveBeenCalled()
    })
  })

  describe('invalidateByPrefix', () => {
    it('should invalidate cache keys matching prefix (Redis)', async () => {
      const mockKeys = [
        'cache:posts-hash1',
        'cache:tags-hash2',
        'cache:other-hash3',
      ]
      mockRedis.keys.mockResolvedValueOnce(mockKeys)
      mockRedis.del.mockImplementation(() => Promise.resolve(1))

      const result = await service.invalidateByPrefix('posts')

      expect(mockRedis.keys).toHaveBeenCalledWith('cache:*')
      expect(mockRedis.del).toHaveBeenCalledTimes(1) // Only 'posts-hash1' matches
      expect(mockLogger.log).toHaveBeenCalledWith(
        'Invalidated 1 cache keys for posts',
      )
      expect(result).toBe(1)
    })

    it('should return 0 for no matching keys', async () => {
      mockRedis.keys.mockResolvedValueOnce(['cache:other-hash'])

      const result = await service.invalidateByPrefix('posts')

      expect(result).toBe(0)
      expect(mockRedis.del).not.toHaveBeenCalled()
    })

    it('should warn for memcached backend', async () => {
      // Reset and mock for memcached
      configService.get.mockReturnValueOnce('memcached') // CACHE_BACKEND

      const result = await service.invalidateByPrefix('posts')

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Bulk invalidation not fully supported'),
      )
      expect(result).toBe(0)
    })
  })

  describe('getCacheKey', () => {
    it('should generate consistent key for same inputs with unified format', () => {
      const result1 = (service as any).getCacheKey(
        'danbooru',
        ' tags: cat ',
        false,
        10,
        ['cat'],
      )
      const result2 = (service as any).getCacheKey(
        'danbooru',
        'tags: cat',
        false,
        10,
        ['cat'],
      )

      expect(result1).toBe(result2)
      expect(result1).toMatch(
        /^cache:danbooru:posts:[0-9a-f]{32}:limit:10:tag:[0-9a-f]{32}$/,
      )
    })

    it('should normalize query and include limit/tags in key structure', () => {
      const result = (service as any).getCacheKey(
        'danbooru',
        '  Tags:  CAT  rating:safe  ',
        false,
        5,
        ['cat', 'safe'],
      )

      expect(result).toMatch(
        /^cache:danbooru:posts:[0-9a-f]{32}:limit:5:tag:[0-9a-f]{32}$/,
      )
      // Verify normalization by testing different equivalent inputs produce same hash
      const key1 = (service as any).getCacheKey(
        'danbooru',
        'tags: cat rating:safe',
        false,
        5,
        ['cat', 'safe'],
      )
      expect(result).toBe(key1)
    })

    it('should include random seed for random queries', () => {
      const keyRandom = (service as any).getCacheKey(
        'danbooru',
        'tags:cat',
        true,
        1,
        ['cat'],
      )
      const keyNoRandom = (service as any).getCacheKey(
        'danbooru',
        'tags:cat',
        false,
        1,
        ['cat'],
      )

      expect(keyRandom).not.toBe(keyNoRandom)
      expect(keyRandom).toMatch(/random-seed:/)
      expect(keyNoRandom).not.toMatch(/random-seed:/)
    })

    it('should generate deterministic random seed for same inputs', () => {
      const seed1 = (service as any).generateRandomSeed('tags:cat', 10, [
        'cat',
        'fluffy',
      ])
      const seed2 = (service as any).generateRandomSeed('tags:cat', 10, [
        'cat',
        'fluffy',
      ])
      const seed3 = (service as any).generateRandomSeed('tags:dog', 5, ['dog'])

      expect(seed1).toBe(seed2)
      expect(seed1).not.toBe(seed3)
      expect(seed1).toHaveLength(16)
      expect(seed1).toMatch(/^[0-9a-f]{16}$/)
    })

    it('should handle missing optional parameters gracefully', () => {
      const keyNoLimit = (service as any).getCacheKey(
        'danbooru',
        'tags:cat',
        false,
      )
      const keyNoTags = (service as any).getCacheKey(
        'danbooru',
        'tags:cat',
        false,
        10,
      )
      const keyRandomNoParams = (service as any).getCacheKey(
        'danbooru',
        'tags:cat',
        true,
      )

      expect(keyNoLimit).toMatch(/^cache:danbooru:posts:[0-9a-f]{32}$/)
      expect(keyNoTags).toMatch(/^cache:danbooru:posts:[0-9a-f]{32}:limit:10$/)
      expect(keyRandomNoParams).toMatch(
        /^cache:danbooru:posts:[0-9a-f]{32}:random-seed:[0-9a-f]{16}$/,
      )
    })

    it('should generate consistent tag hash for same tags regardless of order', () => {
      const key1 = (service as any).getCacheKey(
        'danbooru',
        'tags:cat dog',
        false,
        10,
        ['dog', 'cat'],
      )
      const key2 = (service as any).getCacheKey(
        'danbooru',
        'tags:dog cat',
        false,
        10,
        ['cat', 'dog'],
      )

      expect(key1).toBe(key2)
    })
  })

  describe('invalidateCache', () => {
    beforeEach(() => {
      // Mock pipeline behavior more comprehensively
      const mockPipeline = {
        del: jest.fn().mockReturnThis(),
        exec: jest.fn(),
      }
      mockRedis.pipeline.mockReturnValue(mockPipeline)
    })

    it('should invalidate cache keys matching exact pattern using pipeline (Redis)', async () => {
      const mockKeys = [
        'cache:danbooru:posts:abc123:limit:10:tag:def456',
        'cache:danbooru:posts:ghi789:limit:5:tag:def456',
        'cache:other:posts:jkl012:limit:1:tag:xyz789', // Non-matching
      ]
      mockRedis.keys.mockResolvedValueOnce(mockKeys)
      mockRedis.pipeline().exec.mockResolvedValueOnce([
        ['cache:danbooru:posts:abc123:limit:10:tag:def456', 1],
        ['cache:danbooru:posts:ghi789:limit:5:tag:def456', 1],
        ['cache:other:posts:jkl012:limit:1:tag:xyz789', 0],
      ])

      const pattern = 'cache:danbooru:posts:*:tag:def456'
      const result = await service.invalidateCache(pattern)

      expect(mockRedis.keys).toHaveBeenCalledWith(pattern)
      expect(mockRedis.pipeline().del).toHaveBeenCalledWith(
        'cache:danbooru:posts:abc123:limit:10:tag:def456',
      )
      expect(mockRedis.pipeline().del).toHaveBeenCalledWith(
        'cache:danbooru:posts:ghi789:limit:5:tag:def456',
      )
      expect(mockRedis.pipeline().del).toHaveBeenCalledTimes(2) // Only matching keys
      expect(result).toBe(2)
      expect(mockLogger.log).toHaveBeenCalledWith(
        'Invalidated 2 cache keys matching pattern: cache:danbooru:posts:*:tag:def456',
      )
    })

    it('should return 0 for no matching keys and log debug message', async () => {
      mockRedis.keys.mockResolvedValueOnce([])

      const result = await service.invalidateCache(
        'cache:danbooru:posts:nonexistent:*',
      )

      expect(result).toBe(0)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No cache keys matched pattern: cache:danbooru:posts:nonexistent:*',
      )
      expect(mockRedis.pipeline).not.toHaveBeenCalled()
    })

    it('should handle pipeline execution errors gracefully', async () => {
      mockRedis.keys.mockResolvedValueOnce(['cache:danbooru:posts:abc123'])
      mockRedis
        .pipeline()
        .exec.mockRejectedValueOnce(new Error('Pipeline failed'))

      const result = await service.invalidateCache('cache:danbooru:posts:*')

      expect(result).toBe(0)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to invalidate cache with pattern cache:danbooru:posts:*',
        ),
      )
    })

    it('should warn for memcached backend and return 0 without Redis operations', async () => {
      // Reset and mock for memcached
      configService.get.mockReturnValueOnce('memcached') // CACHE_BACKEND

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile()

      const memcachedService = module.get<CacheService>(CacheService)
      const result = await memcachedService.invalidateCache('cache:danbooru:*')

      expect(result).toBe(0)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Pattern-based invalidation not supported for Memcached',
        ),
      )
      expect(mockRedis.keys).not.toHaveBeenCalled()
      expect(mockRedis.pipeline).not.toHaveBeenCalled()
    })

    it('should use invalidateByPrefix as backward compatibility wrapper', async () => {
      mockRedis.keys.mockResolvedValueOnce([
        'cache:danbooru:posts:abc123',
        'cache:other:def456',
      ])
      mockRedis.pipeline().exec.mockResolvedValueOnce([
        ['cache:danbooru:posts:abc123', 1],
        ['cache:other:def456', 0],
      ])

      const result = await service.invalidateByPrefix('danbooru')

      expect(mockRedis.keys).toHaveBeenCalledWith('cache:danbooru:*')
      expect(result).toBe(1)
    })
  })

  describe('Updated Cache Methods with New Parameters', () => {
    const apiPrefix = 'danbooru'
    const query = 'tags:cat rating:safe'
    const random = false
    const limit = 10
    const tags = ['cat', 'safe']
    const data = {
      type: 'success',
      jobId: 'test-job',
      posts: [{ id: 1 }],
      imageUrl: 'https://example.com/image.jpg',
      author: 'artist',
      tags: 'cat safe',
      rating: 'safe',
      source: 'source',
      copyright: 'copyright',
    } as CacheableResponse

    beforeEach(() => {
      jest
        .spyOn(service as any, 'getCacheKey')
        .mockReturnValue('cache:unified:test-key')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('getCachedResponse should use unified key with all parameters', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data))

      const result = await service.getCachedResponse<CacheableResponse>(
        apiPrefix,
        query,
        random,
        limit,
        tags,
      )

      expect((service as any).getCacheKey).toHaveBeenCalledWith(
        apiPrefix,
        query,
        random,
        limit,
        tags,
      )
      expect(mockRedis.get).toHaveBeenCalledWith('cache:unified:test-key')
      expect(result).toEqual(data)
    })

    it('setCache should use unified key with all parameters and custom TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce(undefined)

      await service.setCache<CacheableResponse>(
        apiPrefix,
        query,
        data,
        random,
        limit,
        tags,
        1800,
      )

      expect((service as any).getCacheKey).toHaveBeenCalledWith(
        apiPrefix,
        query,
        random,
        limit,
        tags,
      )
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'cache:unified:test-key',
        1800,
        JSON.stringify(data),
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`key: cache:unified:test-key`),
      )
    })

    it('getOrSet should pass through limit and tags parameters correctly', async () => {
      const fetchFn = jest.fn().mockResolvedValue(data)
      mockRedis.get.mockResolvedValueOnce(null)
      mockRedis.setex.mockResolvedValueOnce(undefined)

      const result = await service.getOrSet<CacheableResponse>(
        apiPrefix,
        query,
        random,
        fetchFn,
        limit,
        tags,
        1800,
      )

      expect((service as any).getCacheKey).toHaveBeenCalledTimes(2)
      expect((service as any).getCacheKey).toHaveBeenCalledWith(
        apiPrefix,
        query,
        random,
        limit,
        tags,
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'cache:unified:test-key',
        1800,
        JSON.stringify(data),
      )
      expect(result).toEqual(data)
    })

    it('getOrSet should handle null from fetchFn without caching', async () => {
      const fetchFn = jest.fn().mockResolvedValue(null)
      mockRedis.get.mockResolvedValueOnce(null)

      const result = await service.getOrSet<CacheableResponse>(
        apiPrefix,
        query,
        random,
        fetchFn,
        limit,
        tags,
      )

      expect(result).toBeNull()
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(mockRedis.setex).not.toHaveBeenCalled()
    })

    it('deleteCache should use unified key format with all parameters', async () => {
      mockRedis.del.mockResolvedValueOnce(1)

      await service.deleteCache(apiPrefix, query, random, limit, tags)

      expect((service as any).getCacheKey).toHaveBeenCalledWith(
        apiPrefix,
        query,
        random,
        limit,
        tags,
      )
      expect(mockRedis.del).toHaveBeenCalledWith('cache:unified:test-key')
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deleted cache for danbooru'),
      )
    })
  })

  describe('initializeBackend', () => {
    it('should initialize Redis backend', async () => {
      configService.get.mockReturnValueOnce('redis')

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile()

      service = module.get<CacheService>(CacheService)
      const serviceAny = service as any

      expect(serviceAny.backend).toBe('redis')
      expect(serviceAny.redis).toBe(mockRedis)
      expect(serviceAny.memcached).toBeUndefined()
    })

    it('should initialize Memcached backend', async () => {
      const mockMemjs = {
        Client: {
          create: jest.fn().mockReturnValue({
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn(),
          }),
        },
      }
      jest.doMock('memjs', () => mockMemjs)

      configService.get
        .mockReturnValueOnce('memcached')
        .mockReturnValueOnce('127.0.0.1:11211')

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile()

      service = module.get<CacheService>(CacheService)
      const serviceAny = service as any

      expect(serviceAny.backend).toBe('memcached')
      expect(serviceAny.memcached).toBeDefined()
      expect(mockMemjs.Client.create).toHaveBeenCalledWith('127.0.0.1:11211')
    })

    it('should fallback to Redis for unsupported backend', async () => {
      configService.get.mockReturnValueOnce('unsupported')

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile()

      service = module.get<CacheService>(CacheService)
      const serviceAny = service as any

      expect(serviceAny.backend).toBe('redis')
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported cache backend'),
      )
    })
  })
})
