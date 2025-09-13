import { Test, TestingModule } from '@nestjs/testing'
import { ExecutionContext } from '@nestjs/common'
import {
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler'
import { Reflector } from '@nestjs/core'
import type { Request, Response } from 'express'
import type { Socket } from 'net'

import { ApiThrottlerGuard } from './throttler.guard'

class TestApiThrottlerGuard extends ApiThrottlerGuard {
  public testExtractApiPrefix(req: Request): string {
    return this.extractApiPrefix(req)
  }

  public testExtractIp(req: Request): string {
    return this.extractIp(req)
  }

  public async testGetTracker(req: Request): Promise<string> {
    return this.getTracker(req)
  }
}

describe('ApiThrottlerGuard', () => {
  let guard: TestApiThrottlerGuard
  let mockContext: Partial<ExecutionContext>

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60, limit: 10 }],
        }),
      ],
      providers: [
        Reflector,
        TestApiThrottlerGuard,
      ],
    }).compile()

    guard = module.get<TestApiThrottlerGuard>(TestApiThrottlerGuard)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('extractApiPrefix', () => {
    it('should extract "danbooru" from /api/danbooru/posts', () => {
      const mockRequest = {
        path: '/api/danbooru/posts',
      } as unknown as Request

      const result = guard.testExtractApiPrefix(mockRequest)
      expect(result).toBe('danbooru')
    })

    it('should extract "gelbooru" from /api/gelbooru/tags', () => {
      const mockRequest = {
        path: '/api/gelbooru/tags',
      } as unknown as Request

      const result = guard.testExtractApiPrefix(mockRequest)
      expect(result).toBe('gelbooru')
    })

    it('should return "default" for non-matching path', () => {
      const mockRequest = {
        path: '/other/path',
      } as unknown as Request

      const result = guard.testExtractApiPrefix(mockRequest)
      expect(result).toBe('default')
    })

    it('should return "default" for empty path', () => {
      const mockRequest = {
        path: '',
      } as unknown as Request

      const result = guard.testExtractApiPrefix(mockRequest)
      expect(result).toBe('default')
    })
  })

  describe('extractIp', () => {
    it('should return req.ip when available', () => {
      const mockRequest = {
        ip: '127.0.0.1',
      } as unknown as Request

      const result = guard.testExtractIp(mockRequest)
      expect(result).toBe('127.0.0.1')
    })

    it('should fallback to req.connection.remoteAddress', () => {
      const mockConnection = {
        remoteAddress: '192.168.1.1',
      } as unknown as Socket
      const mockRequest = {
        ip: undefined,
        connection: mockConnection,
      } as unknown as Request

      const result = guard.testExtractIp(mockRequest)
      expect(result).toBe('192.168.1.1')
    })

    it('should return "unknown" when no IP available', () => {
      const mockConnection = {} as unknown as Socket
      const mockRequest = {
        ip: undefined,
        connection: mockConnection,
      } as unknown as Request

      const result = guard.testExtractIp(mockRequest)
      expect(result).toBe('unknown')
    })
  })

  describe('getTracker', () => {
    it('should return formatted tracker string', async () => {
      const mockRequest = {
        path: '/api/danbooru/posts',
        ip: 'test-ip',
        headers: { 'x-client-id': 'test-client' },
      } as unknown as Request

      const result = await guard.testGetTracker(mockRequest)
      expect(result).toBe('danbooru:test-ip:test-client')
    })

    it('should use "anonymous" when no x-client-id', async () => {
      const mockRequest = {
        path: '/api/danbooru/posts',
        ip: 'test-ip',
        headers: {},
      } as unknown as Request

      const result = await guard.testGetTracker(mockRequest)
      expect(result).toBe('danbooru:test-ip:anonymous')
    })
  })

  describe('canActivate', () => {
    beforeEach(() => {
      const mockRequest = {
        path: '/api/danbooru/posts',
        ip: '127.0.0.1',
        headers: {},
        connection: { remoteAddress: '127.0.0.1' } as unknown as Socket,
      } as unknown as Request

      const mockGetRequest = jest.fn().mockReturnValue(mockRequest)
      const mockGetResponse = jest.fn().mockReturnValue({} as Response)
      const mockGetNext = jest.fn().mockReturnValue({})

      const mockHttpHost = {
        getRequest: mockGetRequest,
        getResponse: mockGetResponse,
        getNext: mockGetNext,
      }

      mockContext = {
        switchToHttp: () => mockHttpHost,
      }
    })

    it('should call super.canActivate and return its result', async () => {
      const mockSuperCanActivate = jest
        .spyOn(ThrottlerGuard.prototype, 'canActivate')
        .mockResolvedValueOnce(true as boolean)

      const result = await guard.canActivate(mockContext as ExecutionContext)
      expect(mockSuperCanActivate).toHaveBeenCalledWith(mockContext)
      expect(result).toBe(true)

      mockSuperCanActivate.mockRestore()
    })

    it('should handle false from super.canActivate', async () => {
      const mockSuperCanActivate = jest
        .spyOn(ThrottlerGuard.prototype, 'canActivate')
        .mockResolvedValueOnce(false as boolean)

      const result = await guard.canActivate(mockContext as ExecutionContext)
      expect(result).toBe(false)

      mockSuperCanActivate.mockRestore()
    })
  })
})
