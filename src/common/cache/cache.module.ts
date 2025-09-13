import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RedisModule } from '../redis/redis.module'
import { CacheService } from './cache.service'
import { CacheManagerService } from './cache-manager.service'
import { RedisBackendService } from './backends/redis-backend.service'
import { MemcachedBackendService } from './backends/memcached-backend.service'

@Global()
@Module({
  imports: [ConfigModule, RedisModule],
  providers: [
    CacheService,
    CacheManagerService,
    RedisBackendService,
    MemcachedBackendService,
    {
      provide: 'CACHE_BACKEND',
      useFactory: (configService: ConfigService) => {
        const rawBackend = configService.get('CACHE_BACKEND') as string
        const backend = (rawBackend || 'redis') as 'redis' | 'memcached'
        return backend === 'memcached'
          ? MemcachedBackendService
          : RedisBackendService
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    CacheService,
    CacheManagerService,
    'CACHE_BACKEND',
    RedisBackendService,
  ],
})
export class CacheModule {
  static forRootAsync() {
    return {
      module: CacheModule,
      global: true,
      imports: [ConfigModule],
      exports: [CacheModule],
    }
  }
}
