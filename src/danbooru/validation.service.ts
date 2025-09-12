import { Injectable, Logger } from '@nestjs/common'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
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

    // Additional API key validation (already in DTO, but log if needed)
    if (!requestDto.apiKey) {
      this.logger.warn(`Missing API key for job ${requestDto.jobId}`)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId: requestDto.jobId,
        error: 'Missing API key - authentication required',
      }
      return { valid: false, error }
    }

    return { valid: true, dto: requestDto }
  }
}
