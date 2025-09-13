import { Test, TestingModule } from '@nestjs/testing'
import { RateLimiterService } from './rate-limiter.service'
import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'

interface MockPipeline {
  _commands: Array<{ script: string; keys: number; args: unknown[] }>
  eval: jest.Mock<MockPipeline, [string, number, ...unknown[]]>
  exec: jest.Mock<Promise<[null, number][]>>
}

interface RedisMethods {
  eval: jest.Mock<
    Promise<number>,
    [string, number, string, number, number, number]
  >
  get: jest.Mock<Promise<string | null>, [string]>
  ttl: jest.Mock<Promise<number>, [string]>
  del: jest.Mock<Promise<number>, [string]>
  pipeline: jest.Mock<MockPipeline>
}

describe('RateLimiterService', () => {
  let service: RateLimiterService
  let mockRedis: jest.Mocked<RedisMethods>
  let configService: jest.Mocked<ConfigService>
  let mockLog: jest.SpyInstance
  let mockWarn: jest.SpyInstance

  beforeAll(() => {
    mockLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    mockWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  })

  beforeEach(async () => {
    const commands: Array<{ script: string; keys: number; args: unknown[] }> =
      []
    const mockPipeline: MockPipeline = {
      _commands: commands,
      eval: jest.fn(
        (script: string, keys: number, ...args: unknown[]): MockPipeline => {
          commands.push({ script, keys, args })
          return mockPipeline
        },
      ),
      exec: jest.fn(
        (): Promise<[null, number][]> =>
          Promise.resolve(commands.map(() => [null, 1] as [null, number])),
      ),
    }

    mockRedis = {
      eval: jest.fn(),
      get: jest.fn(),
      ttl: jest.fn(),
      del: jest.fn(),
      pipeline: jest.fn(() => mockPipeline),
    } as jest.Mocked<RedisMethods>

    configService = {
      get: jest.fn().mockReturnValue(60), // Default DANBOORU_RATE_LIMIT
    } as unknown as jest.Mocked<ConfigService>

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
        RateLimiterService,
      ],
    }).compile()

    service = module.get<RateLimiterService>(RateLimiterService)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('checkRateLimit', () => {
    it('should allow request when under limit', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      const result = await service.checkRateLimit('user123', 'danbooru', 5, 60)

      expect(result).toBe(true)
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('local key = KEYS[1]'),
        1,
        'rate:danbooru:user123',
        5,
        60,
        expect.any(Number),
      )
      expect(mockWarn).not.toHaveBeenCalled()
    })

    it('should block request when over limit', async () => {
      mockRedis.eval.mockResolvedValueOnce(0)

      const result = await service.checkRateLimit('user123', 'danbooru', 5, 60)

      expect(result).toBe(false)
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('local key = KEYS[1]'),
        1,
        'rate:danbooru:user123',
        5,
        60,
        expect.any(Number),
      )
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Rate limit exceeded for danbooru key rate:danbooru:user123',
        ),
      )
    })

    it('should set EXPIRE only on first increment', async () => {
      mockRedis.eval
        .mockResolvedValueOnce(1) // First call: current = 1, sets EXPIRE
        .mockResolvedValueOnce(1) // Second call: current = 2, no new EXPIRE

      await service.checkRateLimit('user123', 'danbooru', 5, 60)
      await service.checkRateLimit('user123', 'danbooru', 5, 60)

      expect(mockRedis.eval).toHaveBeenCalledTimes(2)
      expect(mockRedis.eval).toHaveBeenLastCalledWith(
        expect.stringContaining('local key = KEYS[1]'),
        1,
        'rate:danbooru:user123',
        5,
        60,
        expect.any(Number),
      )
    })

    it('should generate correct key format', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkRateLimit('192.168.1.1', 'danbooru', 10, 3600)

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('local key = KEYS[1]'),
        1,
        'rate:danbooru:192.168.1.1',
        10,
        3600,
        expect.any(Number),
      )
    })

    it('should lowercase apiPrefix in key', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkRateLimit('user123', 'Danbooru', 5, 60)

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('local key = KEYS[1]'),
        1,
        'rate:danbooru:user123',
        5,
        60,
        expect.any(Number),
      )
    })
  })

  describe('checkSlidingWindow', () => {
    it('should use minute window by default', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkSlidingWindow('danbooru', 'user123', 10)

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:user123',
        10,
        60, // minute window
        expect.any(Number),
      )
    })

    it('should use hour window when specified', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkSlidingWindow('danbooru', 'user123', 100, 'hour')

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:user123',
        100,
        3600, // hour window
        expect.any(Number),
      )
    })

    it('should use day window when specified', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkSlidingWindow('danbooru', 'user123', 1000, 'day')

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:user123',
        1000,
        86400, // day window
        expect.any(Number),
      )
    })

    it('should use global key when no clientId provided', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkSlidingWindow('danbooru', '', 10)

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:global',
        10,
        60,
        expect.any(Number),
      )
    })
  })

  describe('checkCompositeRateLimit', () => {
    let testPipeline: MockPipeline

    beforeEach(() => {
      // Configure pipeline for this test
      const commands: Array<{ script: string; keys: number; args: unknown[] }> =
        []
      const mockPipeline: MockPipeline = {
        _commands: commands,
        eval: jest.fn(
          (script: string, keys: number, ...args: unknown[]): MockPipeline => {
            commands.push({ script, keys, args })
            return mockPipeline
          },
        ),
        exec: jest.fn(
          (): Promise<[null, number][]> =>
            Promise.resolve(commands.map(() => [null, 1] as [null, number])),
        ),
      }
      testPipeline = mockPipeline
      mockRedis.pipeline.mockReturnValue(testPipeline)
    })

    it('should allow when all individual limits are under threshold', async () => {
      testPipeline.exec.mockImplementationOnce(() =>
        Promise.resolve([
          [null, 1],
          [null, 1],
        ]),
      )

      const result = await service.checkCompositeRateLimit(
        'danbooru',
        ['ip:192.168.1.1', 'user:user123'],
        5,
        60,
      )

      expect(result).toBe(true)
      expect(mockRedis.pipeline).toHaveBeenCalledTimes(1)
      expect(mockWarn).not.toHaveBeenCalled()
    })

    it('should block when any individual limit is exceeded', async () => {
      testPipeline.exec.mockImplementationOnce(() =>
        Promise.resolve([
          [null, 1], // First allowed
          [null, 0], // Second blocked
        ]),
      )

      const result = await service.checkCompositeRateLimit(
        'danbooru',
        ['ip:192.168.1.1', 'user:user123'],
        5,
        60,
      )

      expect(result).toBe(false)
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('Composite rate limit exceeded for danbooru'),
      )
    })

    it('should call eval for each identifier in pipeline', async () => {
      testPipeline.exec.mockImplementationOnce(() =>
        Promise.resolve([
          [null, 1],
          [null, 1],
          [null, 1],
        ]),
      )

      await service.checkCompositeRateLimit(
        'danbooru',
        ['ip1', 'ip2', 'ip3'],
        10,
        60,
      )

      expect(testPipeline.eval).toHaveBeenCalledTimes(3)
      expect(testPipeline.eval).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:ip1',
        10,
        60,
        expect.any(Number),
      )
      expect(testPipeline.eval).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:ip2',
        10,
        60,
        expect.any(Number),
      )
      expect(testPipeline.eval).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:ip3',
        10,
        60,
        expect.any(Number),
      )
    })
  })

  describe('getRateLimitStats', () => {
    it('should return stats for specific clientId', async () => {
      mockRedis.get.mockResolvedValueOnce('3')
      mockRedis.ttl.mockResolvedValueOnce(45)
      configService.get.mockReturnValueOnce(10)

      const result = await service.getRateLimitStats('danbooru', 'user123')

      expect(result.current).toBe(3)
      expect(result.limit).toBe(10)
      expect(result.remaining).toBe(7)
      expect(result.resetTime).toBeGreaterThan(0)
      expect(mockRedis.get).toHaveBeenCalledWith('rate:danbooru:user123')
      expect(mockRedis.ttl).toHaveBeenCalledWith('rate:danbooru:user123')
    })

    it('should return stats for global when no clientId', async () => {
      mockRedis.get.mockResolvedValueOnce('0')
      mockRedis.ttl.mockResolvedValueOnce(0)
      configService.get.mockReturnValueOnce(60)

      const result = await service.getRateLimitStats('danbooru')

      expect(result.current).toBe(0)
      expect(result.limit).toBe(60)
      expect(result.remaining).toBe(60)
      expect(result.resetTime).toBeGreaterThan(0)
      expect(mockRedis.get).toHaveBeenCalledWith('rate:danbooru:global')
      expect(mockRedis.ttl).toHaveBeenCalledWith('rate:danbooru:global')
    })

    it('should handle zero current count', async () => {
      mockRedis.get.mockResolvedValueOnce(null)
      mockRedis.ttl.mockResolvedValueOnce(60)
      configService.get.mockReturnValueOnce(100)

      const result = await service.getRateLimitStats('danbooru', 'newuser')

      expect(result.current).toBe(0)
      expect(result.limit).toBe(100)
      expect(result.remaining).toBe(100)
      expect(result.resetTime).toBeGreaterThan(0)
    })

    it('should use config limit or default 60', async () => {
      mockRedis.get.mockResolvedValueOnce('5')
      mockRedis.ttl.mockResolvedValueOnce(30)
      configService.get.mockReturnValueOnce(50)

      const result = await service.getRateLimitStats('danbooru', 'user123')

      expect(result.limit).toBe(50)
    })
  })

  describe('resetRateLimit', () => {
    it('should reset specific clientId', async () => {
      mockRedis.del.mockResolvedValueOnce(1)

      await service.resetRateLimit('danbooru', 'user123')

      expect(mockRedis.del).toHaveBeenCalledWith('rate:danbooru:user123')
      expect(mockLog).toHaveBeenCalledWith(
        'Reset rate limit for danbooru user123',
      )
    })

    it('should reset global counter', async () => {
      mockRedis.del.mockResolvedValueOnce(1)

      await service.resetRateLimit('danbooru')

      expect(mockRedis.del).toHaveBeenCalledWith('rate:danbooru:global')
      expect(mockLog).toHaveBeenCalledWith(
        'Reset rate limit for danbooru global',
      )
    })

    it('should handle non-existent key', async () => {
      mockRedis.del.mockResolvedValueOnce(0)

      await expect(
        service.resetRateLimit('danbooru', 'nonexistent'),
      ).resolves.toBeUndefined()
      expect(mockLog).toHaveBeenCalledWith(
        'Reset rate limit for danbooru nonexistent',
      )
    })
  })

  describe('getWindowSeconds', () => {
    it('should return 60 for minute window', () => {
      const getWindowSeconds = (
        service as unknown as {
          getWindowSeconds: (windowType: string) => number
        }
      ).getWindowSeconds
      const result = getWindowSeconds('minute')
      expect(result).toBe(60)
    })

    it('should return 3600 for hour window', () => {
      const getWindowSeconds = (
        service as unknown as {
          getWindowSeconds: (windowType: string) => number
        }
      ).getWindowSeconds
      const result = getWindowSeconds('hour')
      expect(result).toBe(3600)
    })

    it('should return 86400 for day window', () => {
      const getWindowSeconds = (
        service as unknown as {
          getWindowSeconds: (windowType: string) => number
        }
      ).getWindowSeconds
      const result = getWindowSeconds('day')
      expect(result).toBe(86400)
    })

    it('should default to 60 for unknown window type', () => {
      const getWindowSeconds = (
        service as unknown as {
          getWindowSeconds: (windowType: string) => number
        }
      ).getWindowSeconds
      const result = getWindowSeconds('invalid')
      expect(result).toBe(60)
    })
  })

  describe('boundary conditions', () => {
    it('should allow exactly at limit', async () => {
      mockRedis.eval.mockResolvedValueOnce(1) // current = 5, limit = 5, allowed

      const result = await service.checkRateLimit('user123', 'danbooru', 5, 60)

      expect(result).toBe(true)
      expect(mockWarn).not.toHaveBeenCalled()
    })

    it('should block immediately after limit', async () => {
      mockRedis.eval
        .mockResolvedValueOnce(1) // First call at limit
        .mockResolvedValueOnce(0) // Second call over limit

      await service.checkRateLimit('user123', 'danbooru', 5, 60)
      const result = await service.checkRateLimit('user123', 'danbooru', 5, 60)

      expect(result).toBe(false)
      expect(mockWarn).toHaveBeenCalledTimes(1)
    })

    it('should handle large limits correctly', async () => {
      mockRedis.eval.mockResolvedValueOnce(1)

      await service.checkRateLimit('user123', 'danbooru', 10000, 86400)

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:user123',
        10000,
        86400,
        expect.any(Number),
      )
    })

    it('should handle zero limit (immediate block)', async () => {
      mockRedis.eval.mockResolvedValueOnce(0)

      const result = await service.checkRateLimit('user123', 'danbooru', 0, 60)

      expect(result).toBe(false)
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rate:danbooru:user123',
        0,
        60,
        expect.any(Number),
      )
    })
  })

  describe('error handling', () => {
    it('should handle Redis eval error gracefully', async () => {
      const error = new Error('Redis connection failed')
      mockRedis.eval.mockRejectedValueOnce(error)

      await expect(
        service.checkRateLimit('user123', 'danbooru', 5, 60),
      ).rejects.toThrow('Redis connection failed')
    })

    it('should handle pipeline execution error', async () => {
      const error = new Error('Pipeline failed')
      const testPipeline = mockRedis.pipeline()
      testPipeline.exec.mockRejectedValueOnce(error)

      await expect(
        service.checkCompositeRateLimit('danbooru', ['ip1', 'ip2'], 5, 60),
      ).rejects.toThrow('Pipeline failed')
    })
  })
})
