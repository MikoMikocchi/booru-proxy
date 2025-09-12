import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RateLimiterService } from './rate-limiter.service'

export interface RateLimitError {
  type: 'error'
  jobId: string
  error: string
  retryAfter?: number // Seconds until retry
  apiPrefix?: string
}

export type RateLimitResult =
  | { allowed: false; error: RateLimitError }
  | { allowed: true }

interface RateLimitConfig {
  limit: number
  windowSeconds: number
}

@Injectable()
export class RateLimitManagerService {
  private readonly logger = new Logger(RateLimitManagerService.name)

  /**
   * Manages rate limiting for Danbooru API calls using the underlying RateLimiterService.
   * - Integrates with config-based limits (e.g., DANBOORU_RATE_LIMIT_PER_MINUTE)
   * - Supports clientId-based keys for per-user limits, falls back to global
   * - Returns structured RateLimitResult for easy error handling in services
   * - Uses INCR + EXPIRE strategy for atomicity and automatic cleanup
   * - Ensures backward compatibility with existing DanbooruService integration
   */
  constructor(
    private configService: ConfigService,
    private rateLimiterService: RateLimiterService,
  ) {}

  async checkRateLimit(
    apiPrefix: string,
    jobId: string,
    clientId?: string,
    windowType: 'minute' | 'hour' | 'day' = 'minute',
  ): Promise<RateLimitResult> {
    const rateLimitKey = `${apiPrefix.toUpperCase()}_RATE_LIMIT_PER_${windowType.toUpperCase()}`
    const rateLimitPerWindow =
      this.configService.get<number>(rateLimitKey) || 60
    const windowSeconds = this.getWindowSeconds(windowType)

    const rateKey = clientId
      ? `${apiPrefix.toLowerCase()}:${clientId}`
      : `${apiPrefix.toLowerCase()}:global`

    const isAllowed = await this.rateLimiterService.checkRateLimit(
      rateKey,
      apiPrefix,
      rateLimitPerWindow,
      windowSeconds,
    )

    if (!isAllowed) {
      this.logger.warn(
        `Rate limit exceeded for ${apiPrefix} job ${jobId} (client: ${clientId || 'global'}, limit: ${rateLimitPerWindow}/${windowType})`,
        jobId,
      )

      const error: RateLimitError = {
        type: 'error',
        jobId,
        error: `Rate limit exceeded for ${apiPrefix}. Try again in ${Math.ceil(windowSeconds / 60)} minutes.`,
        retryAfter: windowSeconds,
        apiPrefix,
      }
      return { allowed: false, error }
    }

    this.logger.debug(
      `Rate limit OK for ${apiPrefix} job ${jobId} (${rateLimitPerWindow} remaining)`,
    )
    return { allowed: true }
  }

  // Composite check: IP + clientId + global
  async checkCompositeRateLimit(
    apiPrefix: string,
    jobId: string,
    identifiers: string[],
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const isAllowed = await this.rateLimiterService.checkCompositeRateLimit(
      apiPrefix,
      identifiers,
      limit,
      windowSeconds,
    )

    if (!isAllowed) {
      this.logger.warn(
        `Composite rate limit exceeded for ${apiPrefix} job ${jobId}: ${identifiers.join(', ')}`,
        jobId,
      )

      const error: RateLimitError = {
        type: 'error',
        jobId,
        error: `Rate limit exceeded for ${apiPrefix}. Multiple identifiers blocked.`,
        retryAfter: windowSeconds,
        apiPrefix,
      }
      return { allowed: false, error }
    }

    return { allowed: true }
  }

  // Get detailed stats for specific API/client
  async getRateLimitStatus(
    apiPrefix: string,
    clientId?: string,
    windowType: 'minute' | 'hour' | 'day' = 'minute',
  ): Promise<{
    apiPrefix: string
    clientId?: string
    current: number
    limit: number
    remaining: number
    resetTime: number
    windowType: string
  }> {
    const windowSeconds = this.getWindowSeconds(windowType)
    const rateLimitKey = `${apiPrefix.toUpperCase()}_RATE_LIMIT_PER_${windowType.toUpperCase()}`
    const limit = this.configService.get<number>(rateLimitKey) || 60

    const stats = await this.rateLimiterService.getRateLimitStats(
      apiPrefix,
      clientId,
    )

    return {
      apiPrefix,
      clientId,
      ...stats,
      windowType,
    }
  }

  // Admin method to reset limits for specific API/client
  async resetRateLimit(apiPrefix: string, clientId?: string): Promise<void> {
    await this.rateLimiterService.resetRateLimit(apiPrefix, clientId)
    this.logger.log(
      `Admin reset rate limit for ${apiPrefix} ${clientId || 'global'}`,
    )
  }

  // Dynamic limit configuration per API and window type
  getRateLimitConfig(
    apiPrefix: string,
    windowType: 'minute' | 'hour' | 'day' = 'minute',
  ): RateLimitConfig {
    const rateLimitKey = `${apiPrefix.toUpperCase()}_RATE_LIMIT_PER_${windowType.toUpperCase()}`
    const limit = this.configService.get<number>(rateLimitKey) || 60
    const windowSeconds = this.getWindowSeconds(windowType)

    return { limit, windowSeconds }
  }

  private getWindowSeconds(windowType: string): number {
    switch (windowType) {
      case 'hour':
        return 3600
      case 'day':
        return 86400
      default:
        return 60 // minute
    }
  }

  // Validate rate limit configuration
  validateRateLimitConfig(apiPrefix: string): boolean {
    const configs = ['minute', 'hour', 'day'] as const
    for (const type of configs) {
      const key = `${apiPrefix.toUpperCase()}_RATE_LIMIT_PER_${type.toUpperCase()}`
      const limit = this.configService.get<number>(key)
      if (!limit || limit <= 0) {
        this.logger.warn(
          `Invalid rate limit config for ${apiPrefix} ${type}: ${limit || 'missing'}`,
        )
        return false
      }
    }
    return true
  }
}
