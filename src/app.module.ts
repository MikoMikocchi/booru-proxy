import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DanbooruModule } from './danbooru/danbooru.module'
import { HealthModule } from './health/health.module'
import { RedisModule } from './common/redis/redis.module'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		DanbooruModule,
		RedisModule,
	],
})
export class AppModule {}
