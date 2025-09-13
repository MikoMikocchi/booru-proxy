import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { ValidationPipe, Logger, INestMicroservice } from '@nestjs/common'
import { AppModule } from './app.module'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import * as fs from 'node:fs'
import type { ConnectionOptions } from 'node:tls'

let redisClient: Redis | undefined

async function gracefulShutdown() {
  const logger = new Logger('Shutdown')
  logger.log('Shutting down gracefully...')
  let quitTimedOut = false
  try {
    await app.close()
    if (redisClient) {
      const quitPromise = redisClient.quit()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => {
          quitTimedOut = true
          reject(new Error('Redis quit timeout'))
        }, 5000),
      )

      try {
        await Promise.race([quitPromise, timeoutPromise])
      } catch {
        if (quitTimedOut) {
          logger.warn('Redis quit timed out, forcing disconnect')
          redisClient.disconnect()
        }
      }
    }
  } catch (error) {
    logger.error('Error during shutdown', error as Error)
    if (redisClient) {
      // Force disconnect on any error
      redisClient.disconnect()
    }
  } finally {
    process.exit(0)
  }
}

let app: INestMicroservice

async function bootstrap() {
  const logger = new Logger('Bootstrap')
  try {
    const configService = new ConfigService()
    const redisPassword = configService.get<string>('REDIS_PASSWORD')
    const redisUrlRaw =
      configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
    const useTls = configService.get<boolean>('REDIS_USE_TLS', false)
    logger.debug(`DEBUG: REDIS_PASSWORD=${redisPassword ? '[REDACTED]' : undefined}`)
    logger.debug(`DEBUG: REDIS_URL raw=${redisUrlRaw}`)
    logger.debug(`DEBUG: REDIS_USE_TLS=${useTls}`)

    // Always parse the raw URL (assumes redis:// protocol)
    const parsedUrl = new URL(redisUrlRaw)
    const host = parsedUrl.hostname
    const port = Number(parsedUrl.port) || 6379
    const username = parsedUrl.username || undefined
    const password = parsedUrl.password || redisPassword || undefined

    logger.debug(
      `DEBUG: Parsed - host: ${host}, port: ${port}, username: ${username}, useTls: ${useTls}`,
    )

    let tlsConfig: ConnectionOptions | undefined = undefined
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
          } as ConnectionOptions
        } catch (error) {
          logger.warn('Failed to load TLS certificates', error as Error)
          tlsConfig = {
            rejectUnauthorized: false, // Fallback for dev
          } as ConnectionOptions
        }
      } else {
        tlsConfig = {
          rejectUnauthorized: false, // Fallback if paths not provided
        } as ConnectionOptions
      }
    }

    // Create Redis client for shutdown using the parsed config
    redisClient = new Redis({
      host,
      port,
      username,
      password,
      tls: tlsConfig,
      retryStrategy: (times: number) => {
        if (times > 10) {
          return null
        }
        return Math.min(times * 500, 3000)
      },
    })

    app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.REDIS,
      options: {
        host,
        port,
        username,
        password,
        tls: tlsConfig,
        retryStrategy: (times: number) => {
          if (times > 10) {
            return null
          }
          return Math.min(times * 500, 3000) // Progressive backoff up to 3s
        },
      },
    })

    logger.log('Microservice started (Redis streams)')

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    )

    await app.listen()

    // Set up signal handlers after full initialization
    process.on('SIGINT', () => {
      void gracefulShutdown().catch(err => logger.error('SIGINT shutdown error', err as Error))
    })
    process.on('SIGTERM', () => {
      void gracefulShutdown().catch(err => logger.error('SIGTERM shutdown error', err as Error))
    })
  } catch (error) {
    logger.error('Failed to start microservice', error as Error)
    process.exit(1)
  }
}

void bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap')
  logger.error('Bootstrap failed', err as Error)
  process.exit(1)
})
