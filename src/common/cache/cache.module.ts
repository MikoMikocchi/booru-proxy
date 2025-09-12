import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { CacheService } from './cache.service'
import { CacheManagerService } from './cache-manager.service'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [CacheService, CacheManagerService],
  exports: [CacheService, CacheManagerService],
})
export class CacheModule {}
