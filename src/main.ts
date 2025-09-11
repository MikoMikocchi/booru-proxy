import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { AppModule } from './app.module'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

async function bootstrap() {
  const configService = new ConfigService()
  const redisUrl = configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
  const url = new URL(redisUrl)

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
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

  const microservice = app as any
  const redisClient = microservice.get('REDIS_CLIENT') // Use injected client from RedisModule

  process.on('SIGINT', async () => {
    await redisClient?.quit()
    await app.close()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await redisClient?.quit()
    await app.close()
    process.exit(0)
  })
}

bootstrap()
