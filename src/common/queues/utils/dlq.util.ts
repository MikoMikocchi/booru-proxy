import Redis from 'ioredis'
import { DLQ_DEDUP_WINDOW_SECONDS } from '../../constants'

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

// Deduplication check for DLQ - scans recent entries for matching query within dedup window
export async function dedupCheck(
  redis: Redis,
  apiName: string,
  query: string,
): Promise<boolean> {
  const dlqStream = `${apiName}-dlq`
  const windowMs = DLQ_DEDUP_WINDOW_SECONDS * 1000
  const sinceTimestamp = Date.now() - windowMs

  try {
    // Use XREAD to get recent entries from DLQ stream
    const entries = await redis.xread(
      'BLOCK',
      0, // No block timeout for one-time read
      'STREAMS',
      dlqStream,
      sinceTimestamp.toString(),
      'COUNT',
      100, // Limit to recent 100 entries for performance
    )

    if (!entries || !entries.length) {
      return false
    }

    const streamEntries = entries[0][1] // First stream's entries
    for (const [id, fields] of streamEntries) {
      const entryQuery = fields.find(f => f[0] === 'query')?.[1]
      if (entryQuery === query) {
        return true // Duplicate query found in recent DLQ
      }
    }

    return false
  } catch (error) {
    console.error(`DLQ dedup check failed for query: ${error.message}`)
    return false // On error, don't skip - better to process than risk missing
  }
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
