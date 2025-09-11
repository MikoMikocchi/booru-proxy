import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller'
import { RedisHealthIndicator } from './redis.health'

@Module({
	imports: [TerminusModule],
	controllers: [HealthController],
	providers: [RedisHealthIndicator],
	exports: [RedisHealthIndicator],
})
export class HealthModule {}
