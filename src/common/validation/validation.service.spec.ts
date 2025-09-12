import { Test, TestingModule } from '@nestjs/testing'
import {
  ValidationService,
  ValidationResult,
  ValidationError,
} from './validation.service'
import { ConfigService } from '@nestjs/config'
import { RateLimitManagerService } from '../rate-limit/rate-limit-manager.service'
import { Logger } from '@nestjs/common'
import * as classTransformer from 'class-transformer'
import * as classValidator from 'class-validator'
import * as crypto from 'crypto'

class TestDto {
  tags?: string
  limit?: number
}

jest.mock('class-transformer')
jest.mock('class-validator')

const mockPlainToClass = classTransformer.plainToClass as jest.MockedFunction<
  typeof classTransformer.plainToClass
>
const mockValidate = classValidator.validate as jest.MockedFunction<
  typeof classValidator.validate
>
const mockCreateHmac = crypto.createHmac as jest.MockedFunction<
  typeof crypto.createHmac
>

describe('ValidationService', () => {
  let service: ValidationService
  let mockConfigService: jest.Mocked<ConfigService>
  let mockRateLimitManager: jest.Mocked<RateLimitManagerService>
  let mockLogger: jest.Mocked<Logger>

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn(),
    } as any

    mockRateLimitManager = {
      checkRateLimit: jest.fn(),
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
        ValidationService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RateLimitManagerService, useValue: mockRateLimitManager },
      ],
    }).compile()

    service = module.get<ValidationService>(ValidationService)

    // Reset mocks
    mockPlainToClass.mockClear()
    mockValidate.mockClear()
    jest.clearAllMocks()
    mockRateLimitManager.checkRateLimit.mockClear()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('validateRequest', () => {
    const validJobData: { [key: string]: string } = {
      jobId: 'test-job-123',
      apiKey: 'valid-hmac',
      tags: 'cat rating:safe',
      limit: '10',
      clientId: 'user123',
    }

    const config: any = {
      apiPrefix: 'danbooru',
      hmacSecret: 'test-secret',
      allowedMethods: ['hmac'],
    }

    it('should validate successfully when all checks pass', async () => {
      // Mock DTO validation
      const mockDto = new TestDto()
      mockDto.tags = 'cat rating:safe'
      mockDto.limit = 10
      mockPlainToClass.mockReturnValue(mockDto)
      mockValidate.mockResolvedValue([])

      // Mock authentication
      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(null)

      // Mock rate limit
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any)

      config.customValidator = undefined

      const result = (await service.validateRequest(
        validJobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (result.valid) {
        expect(result.valid).toBe(true)
        expect(result.dto).toBe(mockDto)
        expect(result.dto.tags).toBe('cat rating:safe')
        expect(result.dto.limit).toBe(10)
        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Validation successful for danbooru job test-job-123',
        )
        expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
          'danbooru',
          'test-job-123',
          'user123',
        )
      } else {
        fail('Validation should have passed')
      }
    })

    it('should fail on DTO validation errors', async () => {
      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([
        {
          property: 'tags',
          constraints: { isNotEmpty: 'tags should not be empty' },
        } as any,
      ])

      const result = (await service.validateRequest(
        validJobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (!result.valid) {
        expect(result.valid).toBe(false)
        expect(result.error.code).toBe('INVALID_DTO')
        expect(result.error.error).toBe('Invalid request format')
        expect(result.error.apiPrefix).toBe('danbooru')
        expect(result.error.jobId).toBe('test-job-123')
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'DTO validation failed for danbooru job test-job-123',
          ),
        )
        expect(mockRateLimitManager.checkRateLimit).not.toHaveBeenCalled()
      } else {
        fail('Validation should have failed')
      }
    })

    it('should fail on authentication validation', async () => {
      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([])

      const authError: ValidationError = {
        type: 'error',
        jobId: 'test-job-123',
        error: 'Missing API key',
        code: 'AUTH_FAILED',
        apiPrefix: 'danbooru',
      }
      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(authError)

      const result = (await service.validateRequest(
        validJobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (!result.valid) {
        expect(result.valid).toBe(false)
        expect(result.error).toEqual(authError)
        expect(mockRateLimitManager.checkRateLimit).not.toHaveBeenCalled()
      } else {
        fail('Validation should have failed')
      }
    })

    it('should fail on custom validator error', async () => {
      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([])

      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(null)

      const customError: ValidationError = {
        type: 'error',
        jobId: 'test-job-123',
        error: 'Custom validation failed',
        code: 'CUSTOM_ERROR',
        apiPrefix: 'danbooru',
      }
      config.customValidator = jest.fn().mockResolvedValue(customError)

      const result = (await service.validateRequest(
        validJobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (!result.valid) {
        expect(result.valid).toBe(false)
        expect(result.error).toEqual(customError)
        expect(config.customValidator).toHaveBeenCalledWith(
          validJobData,
          config,
        )
        expect(mockRateLimitManager.checkRateLimit).not.toHaveBeenCalled()
      } else {
        fail('Validation should have failed')
      }
    })

    it('should fail on rate limit validation', async () => {
      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([])

      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(null)
      config.customValidator = undefined

      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: false,
        error: { error: 'Rate limit exceeded' } as any,
      })

      const result = (await service.validateRequest(
        validJobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (!result.valid) {
        expect(result.valid).toBe(false)
        expect(result.error.code).toBe('RATE_LIMIT')
        expect(result.error.error).toBe('Rate limit exceeded')
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'Rate limit validation failed for danbooru job test-job-123',
          ),
        )
      } else {
        fail('Validation should have failed')
      }
    })

    it('should handle missing jobId gracefully', async () => {
      const noJobIdData: { [key: string]: string } = {
        ...validJobData,
        jobId: 'unknown',
      }

      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([])

      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(null)
      mockRateLimitManager.checkRateLimit.mockResolvedValue({ allowed: true })
      config.customValidator = undefined

      const result = (await service.validateRequest(
        noJobIdData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (result.valid) {
        expect(result.valid).toBe(true)
        expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
          'danbooru',
          'unknown',
          'user123',
        )
      } else {
        fail('Validation should have passed')
      }
    })

    it('should skip rate limit if no clientId provided', async () => {
      const noClientIdData: { [key: string]: string } = {
        ...validJobData,
        clientId: 'no-client',
      }

      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([])

      jest
        .spyOn(service as any, 'validateAuthentication')
        .mockResolvedValue(null)
      config.customValidator = undefined

      const result = (await service.validateRequest(
        noClientIdData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>

      if (result.valid) {
        expect(result.valid).toBe(true)
        expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
          'danbooru',
          'test-job-123',
          'no-client',
        )
      } else {
        fail('Validation should have passed')
      }
    })
  })

  describe('validateAuthentication', () => {
    const jobData: { [key: string]: string } = {
      jobId: 'test-job-123',
      apiKey: 'test-key',
      tags: 'cat',
    }

    const config: any = {
      apiPrefix: 'danbooru',
      hmacSecret: 'test-secret',
      allowedMethods: ['hmac'],
    }

    it('should pass validation with correct HMAC', async () => {
      const expectedHmac = 'expected-hmac-hash'
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue(expectedHmac),
      }
      mockCreateHmac.mockReturnValue(mockHmac as any)
      jobData.apiKey = expectedHmac

      const result = await (service as any).validateAuthentication(
        jobData,
        config,
      )

      expect(result).toBeNull()
      expect(mockCreateHmac).toHaveBeenCalledWith('sha256', 'test-secret')
      expect(mockHmac.update).toHaveBeenCalledWith(JSON.stringify(jobData))
      expect(mockHmac.digest).toHaveBeenCalledWith('hex')
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('should fail validation with missing API key', async () => {
      const noApiKeyData: { [key: string]: string } = { ...jobData, apiKey: '' }

      const result = await (service as any).validateAuthentication(
        noApiKeyData,
        config,
      )

      expect(result).not.toBeNull()
      expect(result?.code).toBe('AUTH_FAILED')
      expect(result?.error).toBe('Missing API key')
      expect(result?.jobId).toBe('test-job-123')
      expect(result?.apiPrefix).toBe('danbooru')
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Missing API key for danbooru job test-job-123',
      )
      expect(mockCreateHmac).not.toHaveBeenCalled()
    })

    it('should fail validation with invalid HMAC', async () => {
      const invalidHmac = 'invalid-hmac'
      jobData.apiKey = invalidHmac

      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('valid-hmac'), // Different from provided
      }
      mockCreateHmac.mockReturnValue(mockHmac as any)

      const result = await (service as any).validateAuthentication(
        jobData,
        config,
      )

      expect(result).not.toBeNull()
      expect(result?.code).toBe('AUTH_FAILED')
      expect(result?.error).toBe('Invalid authentication')
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid HMAC for danbooru job test-job-123',
      )
    })

    it('should skip HMAC validation if not enabled', async () => {
      config.allowedMethods = ['none']
      jobData.apiKey = 'any-key'

      const result = await (service as any).validateAuthentication(
        jobData,
        config,
      )

      expect(result).toBeNull()
      expect(mockCreateHmac).not.toHaveBeenCalled()
    })

    it('should skip HMAC validation if no secret provided', async () => {
      config.hmacSecret = undefined
      jobData.apiKey = 'any-key'

      const result = await (service as any).validateAuthentication(
        jobData,
        config,
      )

      expect(result).toBeNull()
      expect(mockCreateHmac).not.toHaveBeenCalled()
    })

    it('should validate API key presence even without HMAC', async () => {
      config.allowedMethods = ['none']
      config.hmacSecret = undefined

      const noApiKeyData: { [key: string]: string } = { ...jobData, apiKey: '' }

      const result = await (service as any).validateAuthentication(
        noApiKeyData,
        config,
      )

      expect(result).not.toBeNull()
      expect(result?.code).toBe('AUTH_FAILED')
      expect(result?.error).toBe('Missing API key')
    })
  })

  describe('validateRateLimit', () => {
    it('should pass when rate limit allows', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any)

      const result = await (service as any).validateRateLimit(
        'danbooru',
        'test-job-123',
        'user123',
      )

      expect(result).toBeNull()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('should fail when rate limit blocks', async () => {
      const rateLimitError = {
        allowed: false,
        error: { error: 'Too many requests' } as any,
      }
      mockRateLimitManager.checkRateLimit.mockResolvedValue(rateLimitError)

      const result = await (service as any).validateRateLimit(
        'danbooru',
        'test-job-123',
        'user123',
      )

      expect(result).not.toBeNull()
      expect(result?.code).toBe('RATE_LIMIT')
      expect(result?.error).toBe('Too many requests')
      expect(result?.jobId).toBe('test-job-123')
      expect(result?.apiPrefix).toBe('danbooru')
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Rate limit validation failed for danbooru job test-job-123',
        ),
      )
    })

    it('should handle rate limit without clientId', async () => {
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any)

      const result = await (service as any).validateRateLimit(
        'danbooru',
        'test-job-123',
      )

      expect(result).toBeNull()
      expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
        'danbooru',
        'test-job-123',
        undefined,
      )
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete validation flow with all components', async () => {
      const fullJobData: { [key: string]: string } = {
        jobId: 'integration-test-1',
        apiKey: 'valid-hmac-key',
        tags: 'cat rating:safe limit:20',
        clientId: 'integration-user',
      }

      const fullConfig: any = {
        apiPrefix: 'danbooru',
        hmacSecret: 'integration-secret',
        allowedMethods: ['hmac'],
        customValidator: jest.fn().mockResolvedValue(null),
      }

      // Mock all dependencies
      const mockDto = new TestDto()
      mockDto.tags = 'cat rating:safe limit:20'
      mockDto.limit = 20
      mockPlainToClass.mockReturnValue(mockDto)
      mockValidate.mockResolvedValue([])

      // Mock HMAC to pass
      const expectedHmac = 'integration-hmac-hash'
      const mockHmac = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue(expectedHmac),
      }
      mockCreateHmac.mockReturnValue(mockHmac as any)
      fullJobData.apiKey = expectedHmac

      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: true,
      } as any)

      const result = (await service.validateRequest(
        fullJobData,
        TestDto,
        fullConfig,
      )) as ValidationResult<TestDto>

      if (result.valid) {
        // Should pass all validation steps
        expect(result.valid).toBe(true)

        // Verify all components were called
        expect(mockPlainToClass).toHaveBeenCalledWith(TestDto, fullJobData)
        expect(mockValidate).toHaveBeenCalledWith(mockDto)
        expect(fullConfig.customValidator).toHaveBeenCalledWith(
          fullJobData,
          fullConfig,
        )
        expect(mockRateLimitManager.checkRateLimit).toHaveBeenCalledWith(
          'danbooru',
          'integration-test-1',
          'integration-user',
        )
        expect(mockLogger.debug).toHaveBeenCalled()
      } else {
        fail('Validation should have passed')
      }
    })

    it('should short-circuit on first validation failure', async () => {
      const failingJobData: { [key: string]: string } = {
        jobId: 'short-circuit-test',
      }

      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([
        {
          property: 'limit',
          constraints: { isNumber: 'must be number' },
        } as any,
      ])

      const result = (await service.validateRequest(failingJobData, TestDto, {
        apiPrefix: 'danbooru',
      })) as ValidationResult<TestDto>

      if (!result.valid) {
        expect(result.valid).toBe(false)
        expect(result.error.code).toBe('INVALID_DTO')

        // Should not call subsequent validations
        expect(mockRateLimitManager.checkRateLimit).not.toHaveBeenCalled()
        expect((service as any).validateAuthentication).not.toHaveBeenCalled()
      } else {
        fail('Validation should have failed')
      }
    })
  })

  describe('error formatting', () => {
    it('should create proper ValidationError objects', async () => {
      const jobData: { [key: string]: string } = { jobId: 'error-test' }
      const config = { apiPrefix: 'test-api' }

      // Test DTO error
      mockPlainToClass.mockReturnValue(new TestDto())
      mockValidate.mockResolvedValue([{ property: 'test' } as any])

      const dtoResult = (await service.validateRequest(
        jobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>
      if (!dtoResult.valid) {
        expect(dtoResult.error).toMatchObject({
          type: 'error',
          jobId: 'error-test',
          code: 'INVALID_DTO',
          apiPrefix: 'test-api',
        })
      }

      // Test rate limit error
      mockValidate.mockResolvedValue([])
      mockRateLimitManager.checkRateLimit.mockResolvedValue({
        allowed: false,
        error: { error: 'Rate limited' } as any,
      })

      const rateResult = (await service.validateRequest(
        jobData,
        TestDto,
        config,
      )) as ValidationResult<TestDto>
      if (!rateResult.valid) {
        expect(rateResult.error).toMatchObject({
          type: 'error',
          jobId: 'error-test',
          code: 'RATE_LIMIT',
          apiPrefix: 'test-api',
          error: 'Rate limited',
        })
      }
    })
  })
})
