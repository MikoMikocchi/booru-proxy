import { Module, Global } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { RedisModule } from '../redis/redis.module'
import { CacheService } from './cache.service'
import { CacheManagerService } from './cache-manager.service'

@Global()
@Module({
  imports: [ConfigModule, RedisModule],
  providers: [CacheService, CacheManagerService],
  exports: [CacheService, CacheManagerService],
})
export class CacheModule {}
