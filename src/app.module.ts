import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import * as Joi from 'joi'
import { DanbooruModule } from './danbooru/danbooru.module'
import { HealthModule } from './health/health.module'
import { RedisModule } from './common/redis/redis.module'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			validationSchema: Joi.object({
				DANBOORU_LOGIN: Joi.string().required(),
				DANBOORU_API_KEY: Joi.string().required(),
				REDIS_URL: Joi.string().default('redis://localhost:6379'),
				RATE_LIMIT_PER_MINUTE: Joi.number().default(60),
				CACHE_TTL_SECONDS: Joi.number().default(3600),
				DANBOORU_LIMIT: Joi.number().default(1),
				DANBOORU_RANDOM: Joi.boolean().default(true),
			}),
			validationOptions: {
				abortEarly: false,
			},
		}),
		DanbooruModule,
		RedisModule,
	],
})
export class AppModule {}
