import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RateLimiterService } from './rate-limiter.service'
import { DanbooruErrorResponse } from './interfaces/danbooru.interface'

@Injectable()
export class RateLimitManagerService {
  private readonly logger = new Logger(RateLimitManagerService.name)

  constructor(
    private configService: ConfigService,
    private rateLimiterService: RateLimiterService,
  ) {}

  async checkRateLimit(
    jobId: string,
    clientId?: string,
  ): Promise<{ allowed: false; error: DanbooruErrorResponse } | { allowed: true }> {
    const rateLimitPerMinute = this.configService.get<number>('RATE_LIMIT_PER_MINUTE') || 60
    const rateKey = clientId ? `rate:danbooru:${clientId}` : `rate:danbooru:global`

    const isAllowed = await this.rateLimiterService.checkRateLimit(
      rateKey,
      rateLimitPerMinute,
      60, // 1 minute window
    )

    if (!isAllowed) {
      this.logger.warn(`Rate limit exceeded for job ${jobId} (client: ${clientId || 'global'})`, jobId)
      const error: DanbooruErrorResponse = {
        type: 'error',
        jobId,
        error: 'Rate limit exceeded. Try again in 1 minute.',
      }
      return { allowed: false, error }
    }

    return { allowed: true }
  }
}
