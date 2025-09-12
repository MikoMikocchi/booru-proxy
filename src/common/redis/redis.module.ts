import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        let redisUrl =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
        const useTls = configService.get<boolean>('REDIS_USE_TLS', false)

        if (useTls) {
          const baseUrl = redisUrl.replace(/^redis:/, 'rediss:')
          const url = new URL(baseUrl)
          const password =
            url.password || configService.get<string>('REDIS_PASSWORD') || ''
          redisUrl = `rediss://${password}@${url.host}`
        }

        const url = new URL(redisUrl)
        let tlsConfig: any = undefined
        if (useTls) {
          const ca = configService.get<string>('REDIS_TLS_CA')
          const cert = configService.get<string>('REDIS_TLS_CERT')
          const key = configService.get<string>('REDIS_TLS_KEY')
          if (ca && cert && key) {
            tlsConfig = {
              ca: ca,
              cert: cert,
              key: key,
            }
          }
        }

        const redisClient = new Redis({
          host: url.hostname,
          port: Number(url.port) || 6379,
          username: url.username || undefined,
          password: url.password || undefined,
          tls: tlsConfig,
          retryStrategy: (times: number) => {
            if (times > 10) {
              return null
            }
            return Math.min(times * 500, 3000) // Progressive backoff up to 3s
          },
          reconnectOnError: (err: Error) => {
            const targetError = 'READONLY'
            if (err.message.includes(targetError)) {
              return 1 // Reconnect after 1s
            }
            return 2 // Reconnect after 2s for other errors
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
