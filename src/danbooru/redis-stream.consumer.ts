import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common'
import Redis from 'ioredis'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateRequestDto } from './dto/create-request.dto'
import { DanbooruService } from './danbooru.service'
import { addToDLQ } from './utils/dlq.util'
import {
  REQUESTS_STREAM,
  RESPONSES_STREAM,
  DLQ_STREAM,
  DEDUP_TTL_SECONDS,
  STREAM_BLOCK_MS,
} from '../common/constants'

@Injectable()
export class RedisStreamConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisStreamConsumer.name)
  private running = true
  private pendingPromises: Promise<void>[] = []

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly danbooruService: DanbooruService,
  ) {
    this.redis.on('error', (error: Error) => {
      this.logger.error(`Redis error in stream consumer: ${error.message}`, error.stack);
    });
  }

  async onModuleInit() {
    this.logger.log('Starting Danbooru stream consumer')
    // Create consumer group if not exists
    try {
      await this.redis.xgroup(
        'CREATE',
        REQUESTS_STREAM,
        'danbooru-group',
        '$',
        'MKSTREAM',
      )
      this.logger.log('Created consumer group danbooru-group')
    } catch (error) {
      if (error.message.includes('BUSYGROUP')) {
        this.logger.log('Consumer group danbooru-group already exists')
      } else {
        this.logger.error('Error creating consumer group', error)
      }
    }
    await this.startConsumer()
  }

  async onModuleDestroy() {
    this.logger.log('Stopping Danbooru stream consumer')
    this.running = false
    if (this.pendingPromises.length > 0) {
      this.logger.log('Waiting for pending promises to settle...')
      await Promise.allSettled(this.pendingPromises)
    }
    this.redis.disconnect()
  }

  private async startConsumer() {
    while (this.running) {
      try {
        type RedisStreamEntry = [string, [string, string[]][]]

        const streams = (await this.redis.xreadgroup(
          'GROUP',
          'danbooru-group',
          'worker-1',
          'BLOCK',
          STREAM_BLOCK_MS,
          'STREAMS',
          REQUESTS_STREAM,
          '>',
        )) as RedisStreamEntry[]

        if (!streams) continue

        for (const [key, messages] of streams) {
          const messagesTyped = messages

          const promises: Promise<void>[] = messagesTyped.map(([id, fields]) => {
            const innerPromise = (async () => {
              const jobData: { [key: string]: string } = {}
              for (let i = 0; i < fields.length; i += 2) {
                jobData[fields[i]] = fields[i + 1]
              }

              const requestDto = plainToClass(CreateRequestDto, jobData)
              const errors = await validate(requestDto)
              if (errors.length > 0) {
                const jobId = jobData.jobId || 'unknown'
                const maskedQuery = jobData.query
                  ? jobData.query.replace(/./g, '*')
                  : '**'
                this.logger.warn(
                  `Validation error for job ${jobId}: ${JSON.stringify(errors)}, query: ${maskedQuery}`,
                  jobId,
                )
                await this.danbooruService.publishResponse(jobId, {
                  type: 'error',
                  jobId,
                  error: 'Invalid request format',
                })
                // Add to dead-letter queue for permanent validation error
                await addToDLQ(
                  this.redis,
                  jobId,
                  'Invalid request format',
                  jobData.query || '',
                )
                await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
                return
              }

              const { jobId, query } = requestDto

              // Deduplication check with per-item TTL
              const processedKey = `processed:${jobId}`
              const isDuplicate = await this.redis.exists(processedKey)
              if (isDuplicate) {
                this.logger.warn(
                  `Duplicate job ${jobId} detected, skipping`,
                  jobId,
                )
                await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
                return
              }

              // Mark as processed with TTL
              await this.redis.setex(processedKey, DEDUP_TTL_SECONDS, '1')

              this.logger.log(
                `Processing job ${jobId} for query: ${query.replace(/./g, '*')}`,
                jobId,
              )

              // Ignore return value for shutdown purposes
              await this.danbooruService.processRequest(jobId, query)
              // ACK the message
              await this.redis.xack(REQUESTS_STREAM, 'danbooru-group', id)
            })()

            this.pendingPromises.push(innerPromise)
            return innerPromise
          })

          await Promise.all(promises)
          this.pendingPromises = this.pendingPromises.filter(p => !promises.includes(p))
        }
      } catch (error) {
        if (this.running) {
          this.logger.error(
            'Error in stream consumer',
            error.stack || error.message,
          )
          // Exponential backoff with jitter for transient errors
          let delay = 5000
          for (let attempt = 0; attempt < 5; attempt++) {
            delay = Math.min(delay * 2 * (1 + Math.random()), 30000)
            await new Promise(resolve => setTimeout(resolve, delay))
            this.logger.warn(
              `Retry attempt ${attempt + 1} after delay ${delay}ms`,
            )
          }
        }
      }
    }
  }
}
