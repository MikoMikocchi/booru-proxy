import { Module } from '@nestjs/common'
import { DanbooruService } from './danbooru.service'

@Module({
	providers: [DanbooruService],
	exports: [DanbooruService],
})
export class DanbooruModule {}
