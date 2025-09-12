import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RateLimiterService } from './rate-limiter.service'
import { RateLimitManagerService } from './rate-limit-manager.service'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RateLimiterService, RateLimitManagerService],
  exports: [RateLimiterService, RateLimitManagerService],
})
export class RateLimitModule {}
