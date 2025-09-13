import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { createHmac, Hmac } from 'crypto'
import { Logger } from '@nestjs/common'
import {
  RateLimitManagerService,
  type RateLimitError,
  type RateLimitResult,
} from '../rate-limit/rate-limit-manager.service'
import {
  ValidationService,
  type ApiValidationConfig,
  type ValidationError,
} from './validation.service'

// Mock DTO class for testing
class MockDto {
  testField: string = ''
}

// Global spies for Logger
const mockLoggerWarn = jest
  .spyOn(Logger.prototype, 'warn')
  .mockImplementation(() => {})
const mockLoggerDebug = jest
  .spyOn(Logger.prototype, 'debug')
  .mockImplementation(() => {})

jest.mock('class-transformer')
jest.mock('class-validator')
jest.mock('crypto')

const mockPlainToClass = plainToClass as jest.MockedFunction<
  typeof plainToClass
>
const mockValidate = validate as jest.MockedFunction<typeof validate>
const mockCreateHmac = createHmac as jest.MockedFunction<typeof createHmac>

describe('ValidationService', () => {
  let service: ValidationService
  let mockConfigService: jest.Mocked<ConfigService>
  let mockRateLimitManagerService: jest.Mocked<RateLimitManagerService>
  let checkRateLimitMock: jest.Mock<Promise<RateLimitResult>>

  const mockJobData = {
    jobId: 'test-job-id',
    apiKey: 'test-api-key',
    clientId: 'test-client',
    testField: 'valid-value',
  } as const

  const mockConfig: ApiValidationConfig = {
    apiPrefix: 'test-api',
  }

  const mockHmacConfig: ApiValidationConfig = {
    apiPrefix: 'test-api',
    hmacSecret: 'test-secret',
    allowedMethods: ['hmac'],
  }

  beforeEach(async () => {
    const configGetMock = jest.fn()
    mockConfigService = {
      get: configGetMock,
    } as unknown as jest.Mocked<ConfigService>

    checkRateLimitMock = jest.fn() as jest.Mock<Promise<RateLimitResult>>
    mockRateLimitManagerService = {
      checkRateLimit: checkRateLimitMock,
    } as unknown as jest.Mocked<RateLimitManagerService>

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationService,
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: RateLimitManagerService,
          useValue: mockRateLimitManagerService,
        },
      ],
    }).compile()

    service = module.get<ValidationService>(ValidationService)

    // Reset mocks
    mockPlainToClass.mockReset()
    mockValidate.mockReset()
    mockCreateHmac.mockReset()
    checkRateLimitMock.mockReset()
    mockLoggerWarn.mockReset()
    mockLoggerDebug.mockReset()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    mockLoggerWarn.mockRestore()
    mockLoggerDebug.mockRestore()
  })

  describe('validateRequest', () => {
    it('should return valid result on successful validation', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)
      mockConfig.customValidator = undefined

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(true)
      expect((result as { dto: MockDto }).dto).toBe(mockDtoInstance)
      expect(mockValidate).toHaveBeenCalledWith(mockDtoInstance)
      expect(checkRateLimitMock).toHaveBeenCalledWith(
        mockConfig.apiPrefix,
        mockJobData.jobId,
        mockJobData.clientId,
      )
      expect(mockLoggerDebug).toHaveBeenCalledWith(
        `Validation successful for ${mockConfig.apiPrefix} job ${mockJobData.jobId}`,
      )
    })

    it('should return error on DTO validation failure', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      const validationErrors = [
        { property: 'testField', constraints: { isString: 'must be string' } },
      ]
      mockValidate.mockResolvedValue(validationErrors)

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(false)
      expect((result as { error: ValidationError }).error).toEqual({
        type: 'error',
        jobId: mockJobData.jobId,
        error: 'Invalid request format',
        code: 'INVALID_DTO',
        apiPrefix: mockConfig.apiPrefix,
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        `DTO validation failed for ${mockConfig.apiPrefix} job ${mockJobData.jobId}: ${JSON.stringify(validationErrors)}`,
        mockJobData.jobId,
      )
      expect(checkRateLimitMock).not.toHaveBeenCalled()
    })

    it('should return error on missing API key', async () => {
      // Arrange
      const jobDataWithoutKey = { ...mockJobData, apiKey: '' }
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])

      // Act
      const result = await service.validateRequest(
        jobDataWithoutKey,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(false)
      expect((result as { error: ValidationError }).error).toEqual({
        type: 'error',
        jobId: jobDataWithoutKey.jobId,
        error: 'Missing API key',
        code: 'AUTH_FAILED',
        apiPrefix: mockConfig.apiPrefix,
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        `Missing API key for ${mockConfig.apiPrefix} job ${jobDataWithoutKey.jobId}`,
      )
      expect(checkRateLimitMock).not.toHaveBeenCalled()
    })

    it('should return error on invalid HMAC', async () => {
      // Arrange
      mockPlainToClass.mockReturnValue(new MockDto())
      mockValidate.mockResolvedValue([])
      const mockHmacInstance: Partial<jest.Mocked<Hmac>> = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('invalid-hmac'),
      }
      mockCreateHmac.mockReturnValue(mockHmacInstance as unknown as Hmac)
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockHmacConfig,
      )

      // Assert
      expect(result.valid).toBe(false)
      expect((result as { error: ValidationError }).error).toEqual({
        type: 'error',
        jobId: mockJobData.jobId,
        error: 'Invalid authentication',
        code: 'AUTH_FAILED',
        apiPrefix: mockHmacConfig.apiPrefix,
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        `Invalid HMAC for ${mockHmacConfig.apiPrefix} job ${mockJobData.jobId}`,
      )
      expect(mockCreateHmac).toHaveBeenCalledWith(
        'sha256',
        mockHmacConfig.hmacSecret,
      )
      expect(mockHmacInstance.update).toHaveBeenCalledWith(
        JSON.stringify(mockJobData),
      )
      expect(mockHmacInstance.digest).toHaveBeenCalledWith('hex')
      expect(checkRateLimitMock).not.toHaveBeenCalled()
    })

    it('should succeed with valid HMAC', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      const mockHmacInstance: Partial<jest.Mocked<Hmac>> = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue(mockJobData.apiKey), // Matches apiKey
      }
      mockCreateHmac.mockReturnValue(mockHmacInstance as unknown as Hmac)
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)
      mockHmacConfig.customValidator = undefined

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockHmacConfig,
      )

      // Assert
      expect(result.valid).toBe(true)
      expect((result as { dto: MockDto }).dto).toBe(mockDtoInstance)
      expect(mockCreateHmac).toHaveBeenCalledWith(
        'sha256',
        mockHmacConfig.hmacSecret,
      )
      expect(mockHmacInstance.update).toHaveBeenCalledWith(
        JSON.stringify(mockJobData),
      )
      expect(mockHmacInstance.digest).toHaveBeenCalledWith('hex')
      expect(checkRateLimitMock).toHaveBeenCalled()
    })

    it('should return error from custom validator', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      const customError: ValidationError = {
        type: 'error',
        jobId: mockJobData.jobId,
        error: 'Custom error',
        code: 'CUSTOM_ERROR',
        apiPrefix: mockConfig.apiPrefix,
      }
      mockConfig.customValidator = jest.fn().mockResolvedValue(customError)
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(false)
      expect((result as { error: ValidationError }).error).toEqual(customError)
      expect(mockConfig.customValidator).toHaveBeenCalledWith(
        mockJobData,
        mockConfig,
      )
      expect(checkRateLimitMock).not.toHaveBeenCalled()
    })

    it('should return error on rate limit exceeded', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      mockConfig.customValidator = undefined
      const rateLimitError: RateLimitError = {
        type: 'error',
        jobId: mockJobData.jobId,
        error: 'Rate limit exceeded',
        retryAfter: 60,
        apiPrefix: mockConfig.apiPrefix,
      }
      checkRateLimitMock.mockResolvedValue({
        allowed: false,
        error: rateLimitError,
      } as RateLimitResult)

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(false)
      expect((result as { error: ValidationError }).error).toEqual({
        type: 'error',
        jobId: mockJobData.jobId,
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT',
        apiPrefix: mockConfig.apiPrefix,
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        `Rate limit validation failed for ${mockConfig.apiPrefix} job ${mockJobData.jobId}: Rate limit exceeded`,
        mockJobData.jobId,
      )
    })

    it('should skip HMAC if not enabled in allowedMethods', async () => {
      // Arrange
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      const configNoHmac: ApiValidationConfig = {
        ...mockHmacConfig,
        allowedMethods: ['none'],
      }
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)
      configNoHmac.customValidator = undefined

      // Act
      const result = await service.validateRequest(
        mockJobData,
        MockDto,
        configNoHmac,
      )

      // Assert
      expect(result.valid).toBe(true)
      expect((result as { dto: MockDto }).dto).toBe(mockDtoInstance)
      expect(mockCreateHmac).not.toHaveBeenCalled()
      expect(checkRateLimitMock).toHaveBeenCalled()
    })

    it('should handle jobId as unknown if missing', async () => {
      // Arrange
      const jobDataNoId = { ...mockJobData, jobId: '' }
      const mockDtoInstance = new MockDto()
      mockPlainToClass.mockReturnValue(mockDtoInstance)
      mockValidate.mockResolvedValue([])
      checkRateLimitMock.mockResolvedValue({ allowed: true } as RateLimitResult)
      mockConfig.customValidator = undefined

      // Act
      const result = await service.validateRequest(
        jobDataNoId,
        MockDto,
        mockConfig,
      )

      // Assert
      expect(result.valid).toBe(true)
      expect((result as { dto: MockDto }).dto).toBe(mockDtoInstance)
      expect(checkRateLimitMock).toHaveBeenCalledWith(
        mockConfig.apiPrefix,
        'unknown',
        mockJobData.clientId,
      )
    })
  })
})
