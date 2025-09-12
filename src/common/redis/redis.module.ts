import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { LockUtil } from './utils/lock.util'

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
          const authPart = url.username ? `${url.username}:${password}` : `:${password}`
          redisUrl = `rediss://${authPart}@${url.host}`
        }

        const url = new URL(redisUrl)
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
              if (!caContent.includes('-----BEGIN CERTIFICATE-----') ||
                  !certContent.includes('-----BEGIN CERTIFICATE-----') ||
                  !keyContent.includes('-----BEGIN PRIVATE KEY-----') &&
                  !keyContent.includes('-----BEGIN RSA PRIVATE KEY-----')) {
                throw new Error('Invalid PEM format in certificate files')
              }

              tlsConfig = {
                ca: [caContent],
                cert: [certContent],
                key: keyContent,
                rejectUnauthorized: process.env.NODE_ENV !== 'development', // Skip validation in dev for self-signed certs
                checkServerIdentity: () => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
              }
            } catch (error) {
              console.warn('Failed to load TLS certificates:', error.message)
              tlsConfig = {
                rejectUnauthorized: false, // Fallback for dev
                checkServerIdentity: () => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
              }
            }
          } else {
            tlsConfig = {
              rejectUnauthorized: false, // Fallback if paths not provided
              checkServerIdentity: () => undefined, // Skip hostname verification for Docker 'redis' vs 'localhost' cert
            }
          }
        }

        const redisClient = new Redis({
          host: url.hostname,
          port: Number(url.port) || (useTls ? 6380 : 6379),
          username: url.username ? url.username : undefined,
          password: url.password || undefined,
          tls: tlsConfig,
          retryStrategy: (times: number) => {
            // Enhanced retry for TLS/network issues
            if (times > 15) {
              return null // Max 15 attempts
            }
            // Exponential backoff: 100ms, 300ms, 900ms, ..., up to 5s
            const delay = Math.min(100 * Math.pow(3, times - 1), 5000)
            return delay
          },
          reconnectOnError: (err: Error) => {
            // Reconnect on TLS handshake failures, connection resets, timeouts
            const tlsErrors = [
              'READONLY', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
              'ENOTFOUND', 'ECONNREFUSED', 'TLS handshake failed',
              'certificate', 'handshake', 'protocol'
            ]

            const errorMsg = err.message.toUpperCase()
            if (tlsErrors.some(error => errorMsg.includes(error.toUpperCase()))) {
              return 2.0 as any // Reconnect after 2s for TLS/network errors
            }

            // Default reconnect for other errors
            return 2.0 as any
          },
          // Additional TLS-specific options
          lazyConnect: true,
          maxRetriesPerRequest: null, // Let retryStrategy handle all retries
          enableReadyCheck: true,
          enableAutoPipelining: true,
        })

        // Enhanced error handling for TLS
        redisClient.on('error', (error: Error) => {
          if (process.env.NODE_ENV !== 'test') {
            console.error('Redis Client Error:', error)
          }
        })

        // Log successful TLS connection
        redisClient.on('connect', () => {
          if (useTls && process.env.NODE_ENV !== 'test') {
            console.log('Redis connected with TLS')
          }
        })

        redisClient.on('ready', () => {
          if (useTls && process.env.NODE_ENV !== 'test') {
            console.log('Redis TLS connection ready')
          }
        })

        // Warn on reconnect attempts
        redisClient.on('reconnecting', (delay: number) => {
          if (process.env.NODE_ENV !== 'test') {
            console.warn(`Redis reconnecting in ${delay}ms`)
          }
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
