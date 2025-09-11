import { Module } from '@nestjs/common'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from './cache.service'
import { RateLimiterService } from './rate-limiter.service'
import { RedisStreamConsumer } from './redis-stream.consumer'

@Module({
	providers: [DanbooruService, DanbooruApiService, CacheService, RateLimiterService, RedisStreamConsumer],
	exports: [DanbooruService],
})
export class DanbooruModule {}
