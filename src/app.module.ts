import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import * as Joi from 'joi'
import { DanbooruModule } from './danbooru/danbooru.module'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			validationSchema: Joi.object({
				DANBOORU_LOGIN: Joi.string().required(),
				DANBOORU_API_KEY: Joi.string().required(),
				REDIS_URL: Joi.string().required(),
			}),
			validationOptions: {
				abortEarly: true,
			},
		}),
		DanbooruModule,
	],
})
export class AppModule {}
