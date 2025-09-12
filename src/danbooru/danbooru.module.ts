import { Module } from '@nestjs/common'
import { RedisModule } from '../common/redis/redis.module'
import { RateLimitModule } from '../common/rate-limit/rate-limit.module'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from './cache.service'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { DlqConsumer } from './dlq.consumer'

@Module({
  imports: [RedisModule, RateLimitModule],
  providers: [
    DanbooruService,
    DanbooruApiService,
    CacheService,
    RedisStreamConsumer,
    DlqConsumer,
  ],
  exports: [DanbooruService],
})
export class DanbooruModule {}
