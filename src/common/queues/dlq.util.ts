import Redis from 'ioredis'

export async function addToDLQ(
  redis: Redis,
  apiName: string,
  jobId: string,
  errorMessage: string,
  query: string,
  retryCount = 0,
): Promise<void> {
  const dlqStream = `${apiName}-dlq`
  await redis.xadd(
    dlqStream,
    '*',
    'jobId',
    jobId,
    'error',
    errorMessage,
    'query',
    query,
    'retryCount',
    retryCount.toString(),
    'apiName',
    apiName,
  )
}

export async function moveToDeadQueue(
  redis: Redis,
  apiName: string,
  jobId: string,
  errorMessage: string,
  query: string,
  finalError?: string,
): Promise<void> {
  const deadQueueStream = `${apiName}-dead`
  await redis.xadd(
    deadQueueStream,
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
    'apiName',
    apiName,
  )
}
