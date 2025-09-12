import { Injectable, Logger } from '@nestjs/common'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { createHmac } from 'crypto'
import { CreateRequestDto } from './dto/create-request.dto'
import { DanbooruErrorResponse } from './interfaces/danbooru.interface'

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name)

  async validateRequest(jobData: { [key: string]: string }): Promise<{ valid: false; error: DanbooruErrorResponse } | { valid: true; dto: CreateRequestDto }> {
    const requestDto = plainToClass(CreateRequestDto, jobData)
    const errors = await validate(requestDto)

    if (errors.length > 0) {
      const jobId = jobData.jobId || 'unknown'
      this.logger.warn(`Validation error for job ${jobId}: ${JSON.stringify(errors)}`)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId,
        error: 'Invalid request format',
      }
      return { valid: false, error }
    }

    // Verify API key using HMAC with shared secret
    const apiSecret = process.env.API_SECRET
    if (!apiSecret) {
      this.logger.error('API_SECRET environment variable is not set')
      throw new Error('Server configuration error: API_SECRET is required')
    }

    if (!requestDto.apiKey) {
      this.logger.warn(`Missing API key for job ${requestDto.jobId}`)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId: requestDto.jobId,
        error: 'Missing API key - authentication required',
      }
      return { valid: false, error }
    }

    const expectedApiKey = createHmac('sha256', apiSecret)
      .update(`${requestDto.jobId}${requestDto.query}`)
      .digest('hex')

    if (requestDto.apiKey !== expectedApiKey) {
      this.logger.warn(`Invalid API key for job ${requestDto.jobId}`)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId: requestDto.jobId,
        error: 'Invalid API key - authentication failed',
      }
      return { valid: false, error }
    }

    this.logger.debug(`API key verified for job ${requestDto.jobId}`)
    return { valid: true, dto: requestDto }
  }
}
