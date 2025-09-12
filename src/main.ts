import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'
import { ConfigService } from '@nestjs/config'
import { ModuleRef } from '@nestjs/core'
import Redis from 'ioredis'

let redisClient: Redis | undefined

async function gracefulShutdown() {
  console.log('Shutting down gracefully...')
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
      } catch (timeoutError) {
        if (quitTimedOut) {
          console.warn('Redis quit timed out, forcing disconnect')
          redisClient.disconnect()
        }
      }
    }
  } catch (error) {
    console.error('Error during shutdown:', error)
    if (redisClient) {
      // Force disconnect on any error
      redisClient.disconnect()
    }
  } finally {
    process.exit(0)
  }
}

let app: any

async function bootstrap() {
  try {
    const configService = new ConfigService()
    const redisPassword = configService.get<string>('REDIS_PASSWORD')
    const redisUrlRaw = configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
    const useTls = configService.get<boolean>('REDIS_USE_TLS', false)
    console.log('DEBUG: REDIS_PASSWORD=', redisPassword)
    console.log('DEBUG: REDIS_URL raw=', redisUrlRaw)
    console.log('DEBUG: REDIS_USE_TLS=', useTls)

    let redisUrl = redisUrlRaw
    if (useTls) {
      const baseUrl = redisUrl.replace(/^redis:/, 'rediss:')
      const url = new URL(baseUrl)
      const password = url.password || redisPassword || ''
      redisUrl = url.username ? `rediss://${password}@${url.host}` : `rediss://:${password}@${url.host}`
    }
    console.log('DEBUG: Constructed REDIS_URL=', redisUrl)

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
              (!keyContent.includes('-----BEGIN PRIVATE KEY-----') &&
               !keyContent.includes('-----BEGIN RSA PRIVATE KEY-----'))) {
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

    // Create Redis client for shutdown using the same config
    redisClient = new Redis({
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      username: undefined,
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
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
        username: url.username ? url.username : undefined,
        tls: tlsConfig,
        retryStrategy: (times: number) => {
          if (times > 10) {
            return null
          }
          return Math.min(times * 500, 3000) // Progressive backoff up to 3s
        },
      },
    })

    console.log('Microservice started (Redis streams)')

    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }))

    await app.listen()

    // Set up signal handlers after full initialization
    process.on('SIGINT', gracefulShutdown)
    process.on('SIGTERM', gracefulShutdown)
  } catch (error) {
    console.error('Failed to start microservice:', error)
    process.exit(1)
  }
}

bootstrap()
