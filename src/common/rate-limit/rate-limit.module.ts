import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { RateLimiterService } from './rate-limiter.service'
import { RateLimitManagerService } from './rate-limit-manager.service'
import { ApiThrottlerGuard } from './throttler.guard'

@Global()
@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        throttlers: [{
          ttl: configService.get('THROTTLE_TTL') || 60,
          limit: configService.get('THROTTLE_LIMIT') || 10,
        }],
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    RateLimiterService,
    RateLimitManagerService,
    ApiThrottlerGuard,
  ],
  exports: [
    RateLimiterService,
    RateLimitManagerService,
    ThrottlerModule,
    ApiThrottlerGuard,
  ],
})
export class RateLimitModule {}
