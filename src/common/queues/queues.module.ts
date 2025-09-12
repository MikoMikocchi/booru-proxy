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
    // Register specific queues for processors
    BullModule.registerQueue(
      {
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
      },
      {
        name: 'danbooru-dlq',
        defaultJobOptions: {
          removeOnComplete: 5,
          removeOnFail: 3,
          attempts: 1, // DLQ jobs typically don't retry
        },
      },
    ),
  ],
  providers: [RedisStreamConsumer, DlqConsumer],
  exports: [BullModule, RedisStreamConsumer, DlqConsumer],
})
export class QueuesModule {}
