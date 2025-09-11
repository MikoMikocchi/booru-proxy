import { Injectable, Inject, Logger } from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class RateLimiterService {
	private readonly logger = new Logger(RateLimiterService.name)

	constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

	async checkRateLimit(
		key: string,
		limit: number,
		windowSeconds: number,
	): Promise<boolean> {
		const luaScript = `
			local key = KEYS[1]
			local limit = tonumber(ARGV[1])
			local window = tonumber(ARGV[2])
			local now = tonumber(ARGV[3])
			local windowStart = now - window

			-- Get all timestamps in the window
			local timestamps = redis.call('ZRANGEBYSCORE', key, windowStart, now)

			-- If count > limit, reject
			if #timestamps >= limit then
				return 0
			end

			-- Add current timestamp
			redis.call('ZADD', key, now, now)
			redis.call('EXPIRE', key, window)

			return 1
		`

		const now = Date.now()
		const result = await this.redis.eval(
			luaScript,
			1,
			key,
			limit,
			windowSeconds,
			now,
		)
		if (result === 0) {
			this.logger.warn(`Rate limit exceeded for key ${key}`)
		}
		return result === 1
	}
}
