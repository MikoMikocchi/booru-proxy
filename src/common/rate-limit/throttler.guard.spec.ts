import { Test, TestingModule } from '@nestjs/testing'
import { ApiThrottlerGuard } from './throttler.guard'
import { RateLimitManagerService } from './rate-limit-manager.service'
import { ConfigService } from '@nestjs/config'
import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { Request, Response, NextFunction } from 'express'

import type { RateLimitResult } from './rate-limit-manager.service'

describe('ApiThrottlerGuard', () => {
  let guard: ApiThrottlerGuard
  let mockRateLimitManager: jest.Mocked<RateLimitManagerService>
  let mockConfigService: jest.Mocked<ConfigService>
  let mockExecutionContext: jest.Mocked<ExecutionContext>
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let mockNext: jest.Mock

  beforeEach(async () => {
    mockRateLimitManager = {
      checkCompositeRateLimit: jest.fn(),
      getRateLimitStatus: jest.fn(),
    } as any

    mockConfigService = {
      get: jest.fn().mockReturnValue('danbooru'),
    } as any

    mockRequest = {
      headers: { 'x-client-id': 'user123' },
      body: {},
    } as Partial<Request>
    Object.defineProperty(mockRequest, 'ip', {
      value: '192.168.1.1',
      writable: true,
      configurable: true,
    })

    mockResponse = {}
    mockNext = jest.fn()

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest as Request,
        getResponse: () => mockResponse as Response,
        getNext: () => mockNext,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }

    mockExecutionContext = {
      getArgByIndex: () => mockContext,
    } as any

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiThrottlerGuard,
        { provide: RateLimitManagerService, useValue: mockRateLimitManager },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile()

    guard = module.get<ApiThrottlerGuard>(ApiThrottlerGuard)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('canActivate', () => {
    it('should allow request when all rate limits pass', async () => {
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 10,
        remaining: 9,
        resetTime: Date.now() + 60000,
        apiPrefix: 'danbooru',
        windowType: 'minute',
      } as RateLimitResult)

      const result = await guard.canActivate(
        mockExecutionContext as ExecutionContext,
      )

      expect(result).toBe(true)
      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['ip:192.168.1.1', 'user:user123'],
        expect.any(Number),
        expect.any(Number),
      )
      expect(mockNext).toHaveBeenCalled()
    })

    it('should block request when IP limit exceeded', async () => {
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: false,
        error: { message: 'Rate limit exceeded' } as any,
      } as RateLimitResult)

      await expect(
        guard.canActivate(mockExecutionContext as ExecutionContext),
      ).rejects.toThrow(UnauthorizedException)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['ip:192.168.1.1', 'user:user123'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should use IP only when no clientId header', async () => {
      mockRequest.headers = {}
      Object.defineProperty(mockRequest, 'ip', {
        value: '192.168.1.1',
        writable: true,
        configurable: true,
      })
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 10,
        remaining: 9,
        resetTime: Date.now() + 60000,
        apiPrefix: 'danbooru',
        windowType: 'minute',
      } as RateLimitResult)

      await guard.canActivate(mockExecutionContext as ExecutionContext)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['ip:192.168.1.1'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should use global limit when no IP or clientId', async () => {
      Object.defineProperty(mockRequest, 'ip', {
        value: undefined,
        writable: true,
        configurable: true,
      })
      mockRequest.headers = {}
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 10,
        remaining: 9,
        resetTime: Date.now() + 60000,
        apiPrefix: 'gelbooru',
        windowType: 'minute',
      } as RateLimitResult)

      await guard.canActivate(mockExecutionContext as ExecutionContext)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['global'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should handle different API prefixes via config', async () => {
      mockConfigService.get.mockReturnValueOnce('gelbooru')
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue(
        Promise.resolve({
          allowed: true,
          current: 1,
          limit: 10,
          remaining: 9,
          resetTime: Date.now() + 60000,
          apiPrefix: 'danbooru',
          windowType: 'minute',
        } as RateLimitResult),
      )

      await guard.canActivate(mockExecutionContext as ExecutionContext)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'gelbooru',
        ['ip:192.168.1.1', 'user:user123'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should extract clientId from query params if no header', async () => {
      mockRequest.headers = undefined
      mockRequest.query = { clientId: 'query-user' } as any
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 10,
        remaining: 9,
        resetTime: Date.now() + 60000,
        apiPrefix: 'danbooru',
        windowType: 'minute',
        clientId: 'query-user',
      } as RateLimitResult)

      await guard.canActivate(mockExecutionContext as ExecutionContext)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['ip:192.168.1.1', 'user:query-user'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should handle composite checks with multiple identifiers', async () => {
      Object.defineProperty(mockRequest, 'ip', {
        value: '192.168.1.1',
        writable: true,
        configurable: true,
      })
      mockRequest.headers = { 'x-client-id': 'user123', 'x-api-key': 'key456' }
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 3,
        limit: 10,
        remaining: 7,
        resetTime: Date.now() + 60000,
        apiPrefix: 'danbooru',
        windowType: 'minute',
      } as RateLimitResult)

      await guard.canActivate(mockExecutionContext as ExecutionContext)

      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalledWith(
        'danbooru',
        ['ip:192.168.1.1', 'user:user123', 'api:key456'],
        expect.any(Number),
        expect.any(Number),
      )
    })

    it('should log rate limit stats on successful pass', async () => {
      const originalLogger = (guard as any).logger
      const mockLogger = { debug: jest.fn() }
      ;(guard as any).logger = mockLogger
      mockRateLimitManager.checkCompositeRateLimit.mockResolvedValue({
        allowed: true,
        current: 2,
        limit: 10,
        remaining: 8,
        resetTime: Date.now() + 3600000,
        apiPrefix: 'danbooru',
        windowType: 'hour',
      } as RateLimitResult)
      mockRateLimitManager.getRateLimitStatus.mockResolvedValue({
        apiPrefix: 'danbooru',
        clientId: 'ip:192.168.1.1',
        current: 2,
        limit: 10,
        remaining: 8,
        resetTime: Date.now() + 3600000,
        windowType: 'hour',
      })

      await guard.canActivate(mockExecutionContext as ExecutionContext)
      ;(guard as any).logger = originalLogger

      expect(mockRateLimitManager.getRateLimitStatus).toHaveBeenCalledWith(
        'danbooru',
        'ip:192.168.1.1',
      )
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit check passed'),
        expect.objectContaining({ remaining: 8 }),
      )
    })

    it('should handle rate limit errors gracefully', async () => {
      const rateLimitError = new Error('Redis unavailable')
      mockRateLimitManager.checkCompositeRateLimit.mockRejectedValue(
        rateLimitError,
      )

      await expect(
        guard.canActivate(mockExecutionContext as ExecutionContext),
      ).rejects.toThrow(UnauthorizedException)
      expect(mockRateLimitManager.checkCompositeRateLimit).toHaveBeenCalled()
    })
  })

  describe('extractIdentifiers', () => {
    it('should extract IP and clientId correctly', () => {
      const identifiers = (guard as any).extractIdentifiers(
        mockRequest as Request,
        'danbooru',
      )
      expect(identifiers).toEqual(['ip:192.168.1.1', 'user:user123'])
    })

    it('should handle missing clientId', () => {
      mockRequest.headers = undefined
      const identifiers = (guard as any).extractIdentifiers(
        mockRequest as Request,
        'danbooru',
      )
      expect(identifiers).toEqual(['ip:192.168.1.1'])
    })

    it('should use global when no identifiers', () => {
      Object.defineProperty(mockRequest, 'ip', {
        value: undefined,
        writable: true,
        configurable: true,
      })
      mockRequest.headers = undefined
      const identifiers = (guard as any).extractIdentifiers(
        mockRequest as Request,
        'danbooru',
      )
      expect(identifiers).toEqual(['global'])
    })

    it('should prefix with apiPrefix', () => {
      const identifiers = (guard as any).extractIdentifiers(
        mockRequest as Request,
        'gelbooru',
      )
      expect(identifiers).toContain('ip:192.168.1.1')
      expect(identifiers).toContain('user:user123')
    })
  })
})
