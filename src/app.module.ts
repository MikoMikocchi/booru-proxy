import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DanbooruModule } from './danbooru/danbooru.module'
import { RedisModule } from './common/redis/redis.module'
import { CacheModule } from './common/cache/cache.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DanbooruModule,
    RedisModule,
    CacheModule,
    RateLimitModule,
  ],
})
export class AppModule {}
