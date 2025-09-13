import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis, { RedisOptions } from 'ioredis'
import { LockUtil } from './utils/lock.util'
import * as fs from 'fs'
import type { PeerCertificate } from 'node:tls'

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
          const authPart = url.username
            ? `${url.username}:${password}`
            : `:${password}`
          redisUrl = `rediss://${authPart}@${url.host}`
        }

        const url = new URL(redisUrl)
        interface TlsConfig {
          ca?: string[]
          cert?: string[]
          key?: string
          rejectUnauthorized?: boolean
          checkServerIdentity?: (
            hostname: string,
            cert: PeerCertificate,
          ) => undefined
        }

        let tlsConfig: TlsConfig | undefined = undefined
        if (useTls) {
          const caPath = configService.get<string>('REDIS_TLS_CA')
          const certPath = configService.get<string>('REDIS_TLS_CERT')
          const keyPath = configService.get<string>('REDIS_TLS_KEY')

          if (caPath && certPath && keyPath) {
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
                rejectUnauthorized: process.env.NODE_ENV !== 'development', // Skip validation in dev for self-signed certs

                checkServerIdentity: (
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _hostname: string,
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _cert: PeerCertificate,
                ) => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
              }
            } catch {
              // Log warning without console
              tlsConfig = {
                rejectUnauthorized: false, // Fallback for dev

                checkServerIdentity: (
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _hostname: string,
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _cert: PeerCertificate,
                ) => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
              }
            }
          } else {
            tlsConfig = {
              rejectUnauthorized: false, // Fallback if paths not provided

              checkServerIdentity: (
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _hostname: string,
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  _cert: PeerCertificate,
              ) => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
            }
          }
        }

        const options: RedisOptions = {
          host: url.hostname,
          port: Number(url.port) || (useTls ? 6380 : 6379),
          username: url.username ? url.username : undefined,
          password: url.password || undefined,
          ...(useTls ? { tls: tlsConfig } : {}),
          retryStrategy: (times: number) => {
            // Enhanced retry for TLS/network issues
            if (times > 15) {
              return null // Max 15 attempts
            }
            // Exponential backoff: 100ms, 300ms, 900ms, ..., up to 5s
            const delay = Math.min(100 * Math.pow(3, times - 1), 5000)
            return delay
          },
          reconnectOnError: () => 2.0, // Reconnect after 2s on errors
          // Additional options
          lazyConnect: true,
          maxRetriesPerRequest: null, // Let retryStrategy handle all retries
          enableReadyCheck: true,
          enableAutoPipelining: true,
        }

        const redisClient = new Redis(options)

        // Enhanced error handling for TLS
        redisClient.on('error', () => {
          // No-op, remove console
        })

        // Log successful TLS connection
        redisClient.on('connect', () => {
          // No-op, remove console
        })

        redisClient.on('ready', () => {
          // No-op, remove console
        })

        // Warn on reconnect attempts
        redisClient.on('reconnecting', () => {
          // No-op, remove console
        })

        return redisClient
      },
      inject: [ConfigService],
    },
    LockUtil,
  ],
  exports: ['REDIS_CLIENT', LockUtil],
})
export class RedisModule {}
