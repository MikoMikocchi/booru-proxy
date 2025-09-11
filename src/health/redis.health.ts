import { Injectable } from '@nestjs/common'
import { HealthIndicatorService, HealthIndicatorResult } from '@nestjs/terminus'
import Redis from 'ioredis'

@Injectable()
export class RedisHealthIndicator {
	constructor(
		private readonly healthIndicatorService: HealthIndicatorService,
	) {}

	async isHealthy(key: string): Promise<HealthIndicatorResult> {
		const indicator = this.healthIndicatorService.check(key)
		const redis = new Redis({ host: 'localhost', port: 6379 })
		try {
			await redis.ping()
			return indicator.up()
		} catch (e) {
			return indicator.down('Redis not available')
		} finally {
			await redis.disconnect()
		}
	}
}
