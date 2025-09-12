import { Module, Global } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RedisModule } from '../redis/redis.module'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { DlqConsumer } from './dlq.consumer'

@Global()
@Module({
  imports: [
    RedisModule,
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      useFactory: async (configService: ConfigService) => {
        let redisUrl =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
        const useTls = configService.get<boolean>('REDIS_USE_TLS', false)
        const password = configService.get<string>('REDIS_PASSWORD') || ''

        if (useTls) {
          const baseUrl = redisUrl.replace(/^redis:/, 'rediss:')
          const url = new URL(baseUrl)
          redisUrl = `rediss://:${password}@${url.host}`
        } else {
          const url = new URL(redisUrl)
          redisUrl = `redis://${url.username || ''}:${password}@${url.host}`
        }

        let tlsConfig: any = undefined
        if (useTls) {
          const caPath = configService.get<string>('REDIS_TLS_CA')
          const certPath = configService.get<string>('REDIS_TLS_CERT')
          const keyPath = configService.get<string>('REDIS_TLS_KEY')

          if (caPath && certPath && keyPath) {
            const fs = require('fs')
            try {
              const caContent = fs.readFileSync(caPath, 'utf8')
              const certContent = fs.readFileSync(certPath, 'utf8')
              const keyContent = fs.readFileSync(keyPath, 'utf8')

              // Validate PEM format
              if (
                !caContent.includes('-----BEGIN CERTIFICATE-----') ||
                !certContent.includes('-----BEGIN CERTIFICATE-----') ||
                (!keyContent.includes('-----BEGIN PRIVATE KEY-----') &&
                  !keyContent.includes('-----BEGIN RSA PRIVATE KEY-----'))
              ) {
                throw new Error('Invalid PEM format in certificate files')
              }

              tlsConfig = {
                ca: [caContent],
                cert: [certContent],
                key: keyContent,
                rejectUnauthorized: process.env.NODE_ENV !== 'development',
                checkServerIdentity: () => undefined,
              }
            } catch (error) {
              console.warn(
                'Failed to load TLS certificates for BullMQ:',
                error.message,
              )
              tlsConfig = {
                rejectUnauthorized: false,
                checkServerIdentity: () => undefined,
              }
            }
          } else {
            tlsConfig = {
              rejectUnauthorized: false,
              checkServerIdentity: () => undefined,
            }
          }
        }

        const url = new URL(redisUrl)
        const connection = {
          host: url.hostname,
          port: Number(url.port) || (useTls ? 6380 : 6379),
          username: url.username ? url.username : undefined,
          password: url.password || undefined,
          url: redisUrl,
          tls: tlsConfig,
          retryStrategy: (times: number) => {
            if (times > 15) {
              return null
            }
            const delay = Math.min(100 * Math.pow(3, times - 1), 5000)
            return delay
          },
          reconnectOnError: (err: Error) => {
            const tlsErrors = [
              'READONLY',
              'ECONNRESET',
              'EPIPE',
              'ETIMEDOUT',
              'ENOTFOUND',
              'ECONNREFUSED',
              'TLS handshake failed',
              'certificate',
              'handshake',
              'protocol',
            ]

            const errorMsg = err.message.toUpperCase()
            if (
              tlsErrors.some(error => errorMsg.includes(error.toUpperCase()))
            ) {
              return 2.0 as any
            }

            return 2.0 as any
          },
          lazyConnect: true,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          enableAutoPipelining: true,
        }

        return {
          connection,
        }
      },
      inject: [ConfigService],
    }),
  ],
  providers: [RedisStreamConsumer, DlqConsumer],
  exports: [BullModule, RedisStreamConsumer, DlqConsumer],
})
export class QueuesModule {
  static forRootAsync() {
    return {
      module: QueuesModule,
      global: true,
      imports: [ConfigModule, RedisModule],
      exports: [QueuesModule],
    }
  }

  static registerApiQueues(apiPrefixes: string[]) {
    const queueImports = apiPrefixes.map(prefix =>
      BullModule.registerQueue({
        name: `${prefix}-requests`,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 5,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      }),
    )

    return {
      module: QueuesModule,
      imports: queueImports,
      exports: [BullModule],
    }
  }
}
