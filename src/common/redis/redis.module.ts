import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { LockUtil } from './utils/lock.util'
import { createRedisConfig } from './utils/redis-config.util'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const options = createRedisConfig(configService)

        const redisClient = new Redis(options)

        return redisClient
      },
      inject: [ConfigService],
    },
    LockUtil,
  ],
  exports: ['REDIS_CLIENT', LockUtil],
})
export class RedisModule {}
