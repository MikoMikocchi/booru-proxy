import { Injectable, Logger } from '@nestjs/common'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { createHmac } from 'crypto'
import { ConfigService } from '@nestjs/config'
import { RateLimitManagerService } from '../rate-limit/rate-limit-manager.service'

export interface ValidationError {
  type: 'error'
  jobId: string
  error: string
  code?: string // 'INVALID_DTO' | 'AUTH_FAILED' | 'RATE_LIMIT' | etc.
  apiPrefix?: string
}

export interface ApiValidationConfig {
  apiPrefix: string
  hmacSecret?: string
  allowedMethods?: string[] // 'hmac' | 'none'
  customValidator?: (
    data: unknown,
    config: ApiValidationConfig,
  ) => Promise<ValidationError | null>
}

export type ValidationResult<T extends object = object> =
  | { valid: false; error: ValidationError }
  | { valid: true; dto: T }

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name)

  constructor(
    private configService: ConfigService,
    private rateLimitManagerService: RateLimitManagerService,
  ) {}

  async validateRequest<T extends object>(
    jobData: { [key: string]: string },
    dtoClass: new () => T,
    config: ApiValidationConfig,
  ): Promise<ValidationResult<T>> {
    const { apiPrefix } = config
    const jobId = jobData.jobId || 'unknown'

    // Step 1: DTO validation
    const requestDto = plainToClass(dtoClass, jobData)
    const dtoErrors = await validate(requestDto as object)

    if (dtoErrors.length > 0) {
      this.logger.warn(
        `DTO validation failed for ${apiPrefix} job ${jobId}: ${JSON.stringify(dtoErrors)}`,
        jobId,
      )
      const error: ValidationError = {
        type: 'error',
        jobId,
        error: 'Invalid request format',
        code: 'INVALID_DTO',
        apiPrefix,
      }
      return { valid: false, error }
    }

    // Step 2: Authentication validation
    const authError = this.validateAuthentication(jobData, config)
    if (authError) {
      return { valid: false, error: authError }
    }

    // Step 3: Custom API-specific validation
    if (config.customValidator) {
      const customError = await config.customValidator(jobData, config)
      if (customError) {
        return { valid: false, error: customError }
      }
    }

    // Step 4: Rate limit validation (mock - integrate with RateLimitModule later)
    const rateLimitError = await this.validateRateLimit(
      apiPrefix,
      jobId,
      jobData.clientId,
    )
    if (rateLimitError) {
      return { valid: false, error: rateLimitError }
    }

    this.logger.debug(`Validation successful for ${apiPrefix} job ${jobId}`)
    return { valid: true, dto: requestDto }
  }

  private async validateRateLimit(
    apiPrefix: string,
    jobId: string,
    clientId?: string,
  ): Promise<ValidationError | null> {
    const result = await this.rateLimitManagerService.checkRateLimit(
      apiPrefix,
      jobId,
      clientId,
    )

    if (!result.allowed) {
      this.logger.warn(
        `Rate limit validation failed for ${apiPrefix} job ${jobId}: ${result.error.error}`,
        jobId,
      )
      return {
        type: 'error' as const,
        jobId,
        error: result.error.error,
        code: 'RATE_LIMIT',
        apiPrefix,
      }
    }

    return null
  }

  private validateAuthentication(
    jobData: { [key: string]: string },
    config: ApiValidationConfig,
  ): ValidationError | null {
    const { apiPrefix, hmacSecret, allowedMethods = ['hmac'] } = config
    const jobId = jobData.jobId || 'unknown'
    const apiKey = jobData.apiKey

    if (!apiKey) {
      this.logger.warn(`Missing API key for ${apiPrefix} job ${jobId}`)
      return {
        type: 'error',
        jobId,
        error: 'Missing API key',
        code: 'AUTH_FAILED',
        apiPrefix,
      }
    }

    // Basic HMAC validation if enabled
    if (allowedMethods.includes('hmac') && hmacSecret) {
      const expectedHmac = createHmac('sha256', hmacSecret)
        .update(JSON.stringify(jobData))
        .digest('hex')
      if (apiKey !== expectedHmac) {
        this.logger.warn(`Invalid HMAC for ${apiPrefix} job ${jobId}`)
        return {
          type: 'error',
          jobId,
          error: 'Invalid authentication',
          code: 'AUTH_FAILED',
          apiPrefix,
        }
      }
    }

    return null
  }
}
