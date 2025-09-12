import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from './cache.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

jest.mock('ioredis');
const RedisMock = require('ioredis');

describe('CacheService', () => {
  let service: CacheService;
  let mockRedis: jest.Mocked<any>;
  let configService: jest.Mocked<ConfigService>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      ping: jest.fn().mockResolvedValue('PONG'),
    } as any;

    configService = {
      get: jest.fn(),
    } as any;

    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    } as any;

    // Mock Redis instance
    RedisMock.default.mockImplementation(() => mockRedis);

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
    }).compile();

    service = module.get<CacheService>(CacheService);

    // Setup config defaults
    configService.get
      .mockReturnValueOnce('redis') // CACHE_BACKEND
      .mockReturnValueOnce(3600); // CACHE_TTL_SECONDS
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('getOrFetch', () => {
    const key = 'cache:test-hash';
    const data = { id: 1, value: 'test' };
    const fetchProvider = jest.fn().mockResolvedValue(data);

    it('should return cached data on hit', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));

      const result = await service.getOrFetch(key, fetchProvider, 3600);

      expect(result).toEqual(data);
      expect(mockRedis.get).toHaveBeenCalledWith(key);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(`Cache hit for key: ${key}`);
    });

    it('should fetch and cache data on miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValueOnce(undefined);

      const result = await service.getOrFetch(key, fetchProvider, 3600);

      expect(result).toEqual(data);
      expect(mockRedis.get).toHaveBeenCalledWith(key);
      expect(fetchProvider).toHaveBeenCalledTimes(1);
      expect(mockRedis.setex).toHaveBeenCalledWith(key, 3600, JSON.stringify(data));
      expect(mockLogger.debug).toHaveBeenCalledWith(`Cache miss for key: ${key}, fetching data`);
      expect(mockLogger.debug).toHaveBeenCalledWith(`Cached fresh data for key: ${key} with TTL: 3600s`);
    });

    it('should handle invalid cached JSON and refetch', async () => {
      mockRedis.get.mockResolvedValueOnce('invalid-json');
      mockRedis.del.mockResolvedValueOnce(1);
      mockRedis.setex.mockResolvedValueOnce(undefined);

      const result = await service.getOrFetch(key, fetchProvider, 3600);

      expect(result).toEqual(data);
      expect(mockRedis.del).toHaveBeenCalledWith(key);
      expect(mockLogger.warn).toHaveBeenCalledWith(`Invalid cached data for key ${key}, fetching fresh`);
      expect(fetchProvider).toHaveBeenCalledTimes(1);
    });

    it('should use default TTL when not provided', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValueOnce(undefined);

      await service.getOrFetch(key, fetchProvider);

      expect(mockRedis.setex).toHaveBeenCalledWith(key, 3600, expect.any(String));
    });

    it('should handle fetch provider throwing error', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const error = new Error('Fetch failed');
      fetchProvider.mockRejectedValueOnce(error);

      await expect(service.getOrFetch(key, fetchProvider, 3600)).rejects.toThrow('Fetch failed');
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('getCachedResponse', () => {
    const apiPrefix = 'posts';
    const query = 'tags:cat rating:safe';
    const random = false;
    const data = { posts: [{ id: 1 }] };

    beforeEach(() => {
      // Mock getCacheKey to return consistent key
      jest.spyOn(service as any, 'getCacheKey').mockReturnValue('cache:test-key');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return parsed cached response', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));

      const result = await service.getCachedResponse(apiPrefix, query, random);

      expect(result).toEqual(data);
      expect(mockRedis.get).toHaveBeenCalledWith('cache:test-key');
    });

    it('should return null on cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await service.getCachedResponse(apiPrefix, query, random);

      expect(result).toBeNull();
    });

    it('should clean invalid cache on parse error', async () => {
      mockRedis.get.mockResolvedValueOnce('invalid-json');
      mockRedis.del.mockResolvedValueOnce(1);

      const result = await service.getCachedResponse(apiPrefix, query, random);

      expect(result).toBeNull();
      expect(mockRedis.del).toHaveBeenCalledWith('cache:test-key');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse cached data'));
    });
  });

  describe('setCache', () => {
    const apiPrefix = 'posts';
    const query = 'tags:cat';
    const response = { posts: [{ id: 1 }] };
    const random = false;

    beforeEach(() => {
      jest.spyOn(service as any, 'getCacheKey').mockReturnValue('cache:test-key');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should cache response with default TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce(undefined);

      await service.setCache(apiPrefix, query, response, random);

      expect(mockRedis.setex).toHaveBeenCalledWith('cache:test-key', 3600, JSON.stringify(response));
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Cached response'));
    });

    it('should cache response with custom TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce(undefined);

      await service.setCache(apiPrefix, query, response, random, 1800);

      expect(mockRedis.setex).toHaveBeenCalledWith('cache:test-key', 1800, JSON.stringify(response));
    });
  });

  describe('deleteCache', () => {
    const apiPrefix = 'posts';
    const query = 'tags:cat';
    const random = false;

    beforeEach(() => {
      jest.spyOn(service as any, 'getCacheKey').mockReturnValue('cache:test-key');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should delete cache entry', async () => {
      mockRedis.del.mockResolvedValueOnce(1);

      await service.deleteCache(apiPrefix, query, random);

      expect(mockRedis.del).toHaveBeenCalledWith('cache:test-key');
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Deleted cache'));
    });
  });

  describe('getOrSet', () => {
    const apiPrefix = 'posts';
    const query = 'tags:cat';
    const random = false;
    const data = { posts: [{ id: 1 }] };
    const fetchFn = jest.fn().mockResolvedValue(data);

    beforeEach(() => {
      jest.spyOn(service as any, 'getCacheKey').mockReturnValue('cache:test-key');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return cached data without calling fetchFn', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn, 3600);

      expect(result).toEqual(data);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('should fetch and cache on miss, then return data', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValueOnce(undefined);

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn, 1800);

      expect(result).toEqual(data);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(mockRedis.setex).toHaveBeenCalledWith('cache:test-key', 1800, JSON.stringify(data));
    });

    it('should handle null from fetchFn', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      fetchFn.mockResolvedValueOnce(null);

      const result = await service.getOrSet(apiPrefix, query, random, fetchFn);

      expect(result).toBeNull();
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('invalidateByPrefix', () => {
    it('should invalidate cache keys matching prefix (Redis)', async () => {
      const mockKeys = ['cache:posts-hash1', 'cache:tags-hash2', 'cache:other-hash3'];
      mockRedis.keys.mockResolvedValueOnce(mockKeys);
      mockRedis.del.mockImplementation(() => Promise.resolve(1));

      const result = await service.invalidateByPrefix('posts');

      expect(mockRedis.keys).toHaveBeenCalledWith('cache:*');
      expect(mockRedis.del).toHaveBeenCalledTimes(1); // Only 'posts-hash1' matches
      expect(mockLogger.log).toHaveBeenCalledWith('Invalidated 1 cache keys for posts');
      expect(result).toBe(1);
    });

    it('should return 0 for no matching keys', async () => {
      mockRedis.keys.mockResolvedValueOnce(['cache:other-hash']);

      const result = await service.invalidateByPrefix('posts');

      expect(result).toBe(0);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should warn for memcached backend', async () => {
      // Reset and mock for memcached
      configService.get.mockReturnValueOnce('memcached'); // CACHE_BACKEND

      const result = await service.invalidateByPrefix('posts');

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Bulk invalidation not fully supported'));
      expect(result).toBe(0);
    });
  });

  describe('getCacheKey', () => {
    it('should generate consistent key for same inputs', () => {
      const result1 = (service as any).getCacheKey('posts', ' tags: cat ', true);
      const result2 = (service as any).getCacheKey('posts', 'tags: cat', true);

      expect(result1).toBe(result2);
      expect(result1).toMatch(/^cache:[0-9a-f]{32}$/);
    });

    it('should normalize query (trim, lowercase, single spaces)', () => {
      const result = (service as any).getCacheKey('posts', '  Tags:  CAT  rating:safe  ', false);

      expect(result).toMatch(/^cache:[0-9a-f]{32}$/);
      // Verify normalization by testing different equivalent inputs produce same hash
      const key1 = (service as any).getCacheKey('posts', 'tags: cat rating:safe', false);
      expect(result).toBe(key1);
    });

    it('should include random flag in key', () => {
      const keyRandom = (service as any).getCacheKey('posts', 'tags:cat', true);
      const keyNoRandom = (service as any).getCacheKey('posts', 'tags:cat', false);

      expect(keyRandom).not.toBe(keyNoRandom);
    });
  });

  describe('initializeBackend', () => {
    it('should initialize Redis backend', async () => {
      configService.get.mockReturnValueOnce('redis');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<CacheService>(CacheService);
      const serviceAny = service as any;

      expect(serviceAny.backend).toBe('redis');
      expect(serviceAny.redis).toBe(mockRedis);
      expect(serviceAny.memcached).toBeUndefined();
    });

    it('should initialize Memcached backend', async () => {
      const mockMemjs = {
        Client: {
          create: jest.fn().mockReturnValue({
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn(),
          }),
        },
      };
      jest.doMock('memjs', () => mockMemjs);

      configService.get
        .mockReturnValueOnce('memcached')
        .mockReturnValueOnce('127.0.0.1:11211');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<CacheService>(CacheService);
      const serviceAny = service as any;

      expect(serviceAny.backend).toBe('memcached');
      expect(serviceAny.memcached).toBeDefined();
      expect(mockMemjs.Client.create).toHaveBeenCalledWith('127.0.0.1:11211');
    });

    it('should fallback to Redis for unsupported backend', async () => {
      configService.get.mockReturnValueOnce('unsupported');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: mockRedis },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<CacheService>(CacheService);
      const serviceAny = service as any;

      expect(serviceAny.backend).toBe('redis');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported cache backend'));
    });
  });
});
