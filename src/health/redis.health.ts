import { Injectable, Inject } from '@nestjs/common'
import { HealthIndicatorService, HealthIndicatorResult } from '@nestjs/terminus'
import Redis from 'ioredis'

@Injectable()
export class RedisHealthIndicator {
	constructor(
		private readonly healthIndicatorService: HealthIndicatorService,
		@Inject('REDIS_CLIENT') private readonly redis: Redis,
	) {}

	async isHealthy(key: string): Promise<HealthIndicatorResult> {
		const indicator = this.healthIndicatorService.check(key)
		try {
			await this.redis.ping()
			return indicator.up()
		} catch (e) {
			return indicator.down('Redis not available')
		}
	}
}
