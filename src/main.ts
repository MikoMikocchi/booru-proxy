import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { ConfigService } from '@nestjs/config'
import { AppModule } from './app.module'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	const configService = app.get(ConfigService)
	const redisUrl = configService.get('REDIS_URL') || 'redis://localhost:6379'
	const url = new URL(redisUrl)
	const microserviceOptions: MicroserviceOptions = {
		transport: Transport.REDIS,
		options: {
			host: url.hostname,
			port: Number(url.port) || 6379,
			username: url.username || undefined,
			password: url.password || undefined,
		},
	}
	app.connectMicroservice(microserviceOptions)
	const port = configService.get('PORT', 3000)
	await app.startAllMicroservices()
	await app.listen(port)

	process.on('SIGINT', async () => {
		await app.close()
		process.exit(0)
	})

	process.on('SIGTERM', async () => {
		await app.close()
		process.exit(0)
	})
}

bootstrap()
