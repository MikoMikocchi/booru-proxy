import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { ValidationPipe, Logger, INestMicroservice } from '@nestjs/common'
import { AppModule } from './app.module'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { createRedisConfig } from './common/redis/utils/redis-config.util'

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
    const redisConfig = createRedisConfig(configService, logger)
    const { host, port, username, password, tls, retryStrategy } = redisConfig

    // Create Redis client for shutdown using the parsed config
    redisClient = new Redis({
      host,
      port,
      username,
      password,
      tls,
      retryStrategy,
    })

    app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.REDIS,
      options: {
        host,
        port,
        username,
        password,
        tls,
        retryStrategy,
      },
    })

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
      void gracefulShutdown().catch(err =>
        logger.error('SIGINT shutdown error', err as Error),
      )
    })
    process.on('SIGTERM', () => {
      void gracefulShutdown().catch(err =>
        logger.error('SIGTERM shutdown error', err as Error),
      )
    })
  } catch (error) {
    logger.error('Failed to start microservice', error as Error)
    process.exit(1)
  }
}

void bootstrap().catch(err => {
  const logger = new Logger('Bootstrap')
  logger.error('Bootstrap failed', err as Error)
  process.exit(1)
})
