import { Injectable, Inject, Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { ConfigService } from '@nestjs/config'

interface RateLimitConfig {
  limit: number
  windowSeconds: number
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name)

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private configService: ConfigService,
  ) {}

  async checkRateLimit(
    key: string,
    apiPrefix: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const fullKey = `rate:${apiPrefix.toLowerCase()}:${key}`

    // Use atomic INCR + EXPIRE for better performance than ZSET
    const luaScript = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])

      -- Increment counter atomically
      local current = redis.call('INCR', key)

      -- Set expiration if first request in window
      if current == 1 then
        redis.call('EXPIRE', key, window)
      end

      -- Check if over limit
      if current > limit then
        return 0
      end

      return 1
    `

    const now = Date.now()
    const result = await this.redis.eval(
      luaScript,
      1,
      fullKey,
      limit,
      windowSeconds,
      now,
    )

    if (result === 0) {
      this.logger.warn(
        `Rate limit exceeded for ${apiPrefix} key ${fullKey} (limit: ${limit}/${windowSeconds}s)`,
      )
    }

    return result === 1
  }

  // Generic method for different window sizes (minute, hour, day)
  async checkSlidingWindow(
    apiPrefix: string,
    clientId: string,
    limit: number,
    windowType: 'minute' | 'hour' | 'day' = 'minute',
  ): Promise<boolean> {
    const windowSeconds = this.getWindowSeconds(windowType)
    const key = clientId || 'global'
    return this.checkRateLimit(key, apiPrefix, limit, windowSeconds)
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

  // Bulk rate limit check for multiple keys (e.g. IP + clientId)
  async checkCompositeRateLimit(
    apiPrefix: string,
    identifiers: string[],
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const pipeline = this.redis.pipeline()
    const results = []

    for (const id of identifiers) {
      const key = `rate:${apiPrefix.toLowerCase()}:${id}`
      pipeline.eval(
        `
          local key = KEYS[1]
          local limit = tonumber(ARGV[1])
          local window = tonumber(ARGV[2])
          local now = tonumber(ARGV[3])

          local current = redis.call('INCR', key)
          if current == 1 then
            redis.call('EXPIRE', key, window)
          end

          if current > limit then
            return 0
          end
          return 1
        `,
        1,
        key,
        limit,
        windowSeconds,
        Date.now(),
      )
    }

    const rawResults = await pipeline.exec()
    for (const [, result] of rawResults || []) {
      results.push(result === 1)
    }

    const allowed = results.every(r => r === true)
    if (!allowed) {
      this.logger.warn(
        `Composite rate limit exceeded for ${apiPrefix}: ${identifiers.join(', ')}`,
      )
    }

    return allowed
  }

  // Get rate limit stats for monitoring
  async getRateLimitStats(
    apiPrefix: string,
    clientId?: string,
  ): Promise<{
    current: number
    limit: number
    remaining: number
    resetTime: number
  }> {
    const key = clientId
      ? `rate:${apiPrefix.toLowerCase()}:${clientId}`
      : `rate:${apiPrefix.toLowerCase()}:global`
    const [current, ttl] = await Promise.all([
      this.redis.get(key),
      this.redis.ttl(key),
    ])

    const limit =
      this.configService.get<number>(`${apiPrefix.toUpperCase()}_RATE_LIMIT`) ||
      60
    const currentNum = parseInt(current || '0', 10)

    return {
      current: currentNum,
      limit,
      remaining: Math.max(0, limit - currentNum),
      resetTime: Date.now() + ttl * 1000,
    }
  }

  // Clear rate limit counters (for testing or admin)
  async resetRateLimit(apiPrefix: string, clientId?: string): Promise<void> {
    const key = clientId
      ? `rate:${apiPrefix.toLowerCase()}:${clientId}`
      : `rate:${apiPrefix.toLowerCase()}:global`
    await this.redis.del(key)
    this.logger.log(`Reset rate limit for ${apiPrefix} ${clientId || 'global'}`)
  }
}
