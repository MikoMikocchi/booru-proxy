import { Module } from '@nestjs/common'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from './cache.service'
import { RateLimiterService } from './rate-limiter.service'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { DlqConsumer } from './dlq.consumer'

@Module({
  providers: [
    DanbooruService,
    DanbooruApiService,
    CacheService,
    RateLimiterService,
    RedisStreamConsumer,
    DlqConsumer,
  ],
  exports: [DanbooruService],
})
export class DanbooruModule {}
