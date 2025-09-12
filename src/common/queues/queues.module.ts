import { Module, Global } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RedisModule } from '../redis/redis.module'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RedisStreamConsumer } from './redis-stream.consumer'
import { DlqConsumer } from './dlq.consumer'

@Global()
@Module({
  imports: [
    RedisModule,
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      useFactory: async (configService: ConfigService) => {
        const redisUrl =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
        return {
          connection: {
            url: redisUrl,
          },
        }
      },
      inject: [ConfigService],
    }),
    // Register main queue for request processing
    BullModule.registerQueue({
      name: 'danbooru-requests',
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    }),
  ],
  providers: [RedisStreamConsumer, DlqConsumer],
  exports: [BullModule, RedisStreamConsumer, DlqConsumer],
})
export class QueuesModule {}
