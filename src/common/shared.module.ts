import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { RedisModule } from '@nestjs-modules/ioredis';
import { ThrottlerModule } from '@nestjs/throttler';
import { ValidationModule } from './validation/validation.module';
import { parseRedisUrl } from './redis/utils/redis.util';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
    }),
    RedisModule,
    ThrottlerModule.forRoot({
      throttlers: [{
        ttl: 60,
        limit: 10,
      }],
    }),
    ValidationModule,
  ],
  exports: [
    CacheModule,
    RedisModule,
    ThrottlerModule,
    ValidationModule,
  ],
})
export class SharedModule {}

export { parseRedisUrl };
