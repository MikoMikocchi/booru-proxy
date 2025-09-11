import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { parseRedisUrl } from '../utils/redis.util'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const redisUrl =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
        const parsedUrl = parseRedisUrl(redisUrl)
        const redisClient = new Redis({
          host: parsedUrl.hostname,
          port: Number(parsedUrl.port) || 6379,
          username: parsedUrl.username || undefined,
          password: parsedUrl.password || undefined,
          tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
          retryStrategy: (times: number) => {
            if (times > 10) {
              return null // Stop retrying after 10 attempts
            }
            return Math.min(times * 100, 2000) // Exponential backoff, max 2s
          },
          reconnectOnError: (err: Error) => {
            const targetError = 'READONLY'
            if (err.message.includes(targetError)) {
              return 1 // Reconnect after 1s
            }
            return 1 // Reconnect always
          },
        })

        // Global error handler - suppress in test environment
        redisClient.on('error', (error: Error) => {
          if (process.env.NODE_ENV !== 'test') {
            console.error('Redis Client Error:', error)
          }
        })

        return redisClient
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
