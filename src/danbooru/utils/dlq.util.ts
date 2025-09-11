import Redis from 'ioredis'
import { DLQ_STREAM, DEAD_QUEUE_STREAM } from '../../common/constants'

export async function addToDLQ(
  redis: Redis,
  jobId: string,
  errorMessage: string,
  query: string,
  retryCount = 0,
): Promise<void> {
  await redis.xadd(
    DLQ_STREAM,
    '*',
    'jobId',
    jobId,
    'error',
    errorMessage,
    'query',
    query,
    'retryCount',
    retryCount.toString(),
  )
}

export async function moveToDeadQueue(
  redis: Redis,
  jobId: string,
  errorMessage: string,
  query: string,
  finalError?: string,
): Promise<void> {
  await redis.xadd(
    DEAD_QUEUE_STREAM,
    '*',
    'jobId',
    jobId,
    'error',
    errorMessage,
    'query',
    query,
    'finalError',
    finalError || 'Max retries exceeded',
    'timestamp',
    Date.now().toString(),
  )
}
