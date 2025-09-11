import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, HealthCheckResult, HealthIndicatorResult } from '@nestjs/terminus'
import { RedisHealthIndicator } from './redis.health'

@Controller('health')
export class HealthController {
	constructor(
		private readonly health: HealthCheckService,
		private readonly redisHealthIndicator: RedisHealthIndicator,
	) {}

	@Get()
	@HealthCheck()
	async check(): Promise<HealthCheckResult> {
		return this.health.check([
			() => this.redisHealthIndicator.isHealthy('redis'),
		])
	}
}
