import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { AppModule } from './app.module'

async function bootstrap() {
	const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
	const url = new URL(redisUrl)
	const app = await NestFactory.createMicroservice<MicroserviceOptions>(
		AppModule,
		{
			transport: Transport.REDIS,
			options: {
				host: url.hostname,
				port: Number(url.port),
			},
		},
	)

	await app.listen()

	process.on('SIGINT', () => {
		void app.close()
		process.exit(0)
	})

	process.on('SIGTERM', () => {
		void app.close()
		process.exit(0)
	})
}

void bootstrap()
