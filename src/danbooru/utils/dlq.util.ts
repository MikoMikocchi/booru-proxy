import Redis from 'ioredis'
import { DLQ_STREAM } from '../../common/constants'

export async function addToDLQ(
  redis: Redis,
  jobId: string,
  errorMessage: string,
  query: string,
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
  )
}
