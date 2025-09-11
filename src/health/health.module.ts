import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { RedisHealthIndicator } from './redis.health'

@Module({
	imports: [TerminusModule],
	providers: [RedisHealthIndicator],
	exports: [RedisHealthIndicator],
})
export class HealthModule {}
