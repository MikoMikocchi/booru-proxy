import { Injectable, Logger, Inject } from '@nestjs/common'
import { Processor } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import Redis from 'ioredis'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateRequestDto } from '../../danbooru/dto/create-request.dto'
import { DanbooruService } from '../../danbooru/danbooru.service'
import { ValidationService } from '../../danbooru/validation.service'
import { addToDLQ } from './dlq.util'
import { DEDUP_TTL_SECONDS } from '../../common/constants'

@Processor('danbooru-requests', { concurrency: 5 })
@Injectable()
export class RedisStreamConsumer {
  private readonly logger = new Logger(RedisStreamConsumer.name)

  constructor(
    private readonly danbooruService: DanbooruService,
    private readonly validationService: ValidationService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async process(job: Job<{ jobId: string; query: string; clientId: string }>) {
    const data = job.data
    const { jobId, query, clientId } = data

    this.logger.log(
      `Processing job ${jobId} for query: ${query.replace(/./g, '*')}`,
      jobId,
    )

    // Deduplication check
    const processedKey = `processed:${jobId}`
    const result = await this.redis.set(
      processedKey,
      '1',
      'EX',
      DEDUP_TTL_SECONDS,
      'NX',
    )
    if (result !== 'OK') {
      this.logger.warn(`Duplicate job ${jobId} detected, skipping`, jobId)
      return { skipped: true }
    }

    // Validation
    const validation = await this.validationService.validateRequest(data)
    if (!validation.valid) {
      this.logger.warn(
        `Validation failed for job ${jobId}: ${validation.error.error}`,
        jobId,
      )
      await this.danbooruService.publishResponse(jobId, validation.error)
      await addToDLQ(
        this.redis,
        'danbooru',
        jobId,
        validation.error.error,
        query,
      )
      throw new Error(`Validation failed: ${validation.error.error}`)
    }

    try {
      await this.danbooruService.processRequest(jobId, query, clientId)
      return { success: true }
    } catch (error) {
      this.logger.error(
        `Failed to process job ${jobId}: ${error.message}`,
        jobId,
      )
      await addToDLQ(this.redis, 'danbooru', jobId, error.message, query)
      throw error // Let BullMQ handle retry
    }
  }
}
