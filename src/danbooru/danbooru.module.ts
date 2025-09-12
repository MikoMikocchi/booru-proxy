import { Module } from '@nestjs/common'
import { CacheModule } from '../common/cache/cache.module'
import { QueuesModule } from '../common/queues/queues.module'
import { RedisModule } from '../common/redis/redis.module'
import { RateLimitModule } from '../common/rate-limit/rate-limit.module'
import { DanbooruService } from './danbooru.service'
import { DanbooruApiService } from './danbooru-api.service'

@Module({
  imports: [CacheModule, QueuesModule, RedisModule, RateLimitModule],
  providers: [DanbooruService, DanbooruApiService],
  exports: [DanbooruService],
})
export class DanbooruModule {}
