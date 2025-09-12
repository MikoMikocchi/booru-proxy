import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { SharedModule } from './common/shared.module'
import { DanbooruModule } from './danbooru/danbooru.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    SharedModule,
    DanbooruModule,
  ],
})
export class AppModule {}
