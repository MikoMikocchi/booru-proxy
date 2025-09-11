import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DanbooruModule } from './danbooru/danbooru.module'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		DanbooruModule,
	],
})
export class AppModule {}
