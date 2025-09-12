import { Module } from '@nestjs/common'
import { QueuesModule } from '../common/queues/queues.module'
import { RedisModule } from '../common/redis/redis.module'
import { RateLimitModule } from '../common/rate-limit/rate-limit.module'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'
import { CacheService } from './cache.service'

@Module({
  imports: [QueuesModule, RedisModule, RateLimitModule],
  providers: [DanbooruService, DanbooruApiService, CacheService],
  exports: [DanbooruService],
})
export class DanbooruModule {}
