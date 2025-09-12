import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
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
    const redisUrl =
      configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
    const url = new URL(redisUrl)

    app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.REDIS,
      options: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
        username: url.username || undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined,
        retryAttempts: 10,
        retryDelay: 3000,
      },
    })

    console.log('Microservice started (Redis streams)')

    await app.listen()

    // Resolve Redis client via DI after listen() when container is fully initialized
    const moduleRef = app.get(ModuleRef)
    redisClient = moduleRef.get('REDIS_CLIENT')

    // Set up signal handlers after full initialization
    process.on('SIGINT', gracefulShutdown)
    process.on('SIGTERM', gracefulShutdown)
  } catch (error) {
    console.error('Failed to start microservice:', error)
    process.exit(1)
  }
}

bootstrap()
