import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { CacheModule } from '@nestjs/cache-manager'
import { RedisModule } from './redis/redis.module'
import { ThrottlerModule } from '@nestjs/throttler'
import { ValidationModule } from './validation/validation.module'
import { parseRedisUrl } from './redis/utils/redis-config.util'

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: (configService: ConfigService) => ({
        store:
          configService.get('CACHE_BACKEND') === 'memcached'
            ? 'memcached'
            : 'redis',
        ttl: configService.get('CACHE_TTL_SECONDS', 3600) / 1000, // Convert to seconds for cache-manager
        max: 100, // Max items in cache
      }),
      inject: [ConfigService],
    }),
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: 60,
            limit: configService.get('RATE_LIMIT_PER_MINUTE', 60),
          },
        ],
      }),
      inject: [ConfigService],
    }),
    ValidationModule,
  ],
  exports: [CacheModule, RedisModule, ThrottlerModule, ValidationModule],
})
export class SharedModule {}

export { parseRedisUrl }
