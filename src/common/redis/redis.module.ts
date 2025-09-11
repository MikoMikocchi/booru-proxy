import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import { parseRedisUrl } from '../utils/redis.util'

@Global()
@Module({
	imports: [ConfigModule],
	providers: [
		{
			provide: 'REDIS_CLIENT',
			useFactory: (configService: ConfigService) => {
				const redisUrl =
					configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
				const parsedUrl = parseRedisUrl(redisUrl)
				return new Redis({
					host: parsedUrl.hostname,
					port: Number(parsedUrl.port) || 6379,
					username: parsedUrl.username || undefined,
					password: parsedUrl.password || undefined,
					tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
				})
			},
			inject: [ConfigService],
		},
	],
	exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
