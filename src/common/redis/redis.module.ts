import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

@Global()
@Module({
	imports: [ConfigModule],
	providers: [
		{
			provide: 'REDIS_CLIENT',
			useFactory: (configService: ConfigService) => {
				const redisUrl =
					configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
				const url = new URL(redisUrl)
				return new Redis({
					host: url.hostname,
					port: Number(url.port) || 6379,
					username: url.username || undefined,
					password: url.password || undefined,
					tls: url.protocol === 'rediss:' ? {} : undefined,
				})
			},
			inject: [ConfigService],
		},
	],
	exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
