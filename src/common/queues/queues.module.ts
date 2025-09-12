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
  ],
  providers: [RedisStreamConsumer, DlqConsumer],
  exports: [BullModule, RedisStreamConsumer, DlqConsumer],
})
export class QueuesModule {
  static forRootAsync() {
    return {
      module: QueuesModule,
      global: true,
      imports: [ConfigModule, RedisModule],
      exports: [QueuesModule],
    };
  }

  static registerApiQueues(apiPrefixes: string[]) {
    const queueImports = apiPrefixes.map(prefix => BullModule.registerQueue({
      name: `${prefix}-requests`,
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    }));

    return {
      module: QueuesModule,
      imports: queueImports,
      exports: [BullModule],
    };
  }
}
