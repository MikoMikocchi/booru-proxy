import Redis from 'ioredis'
import { DLQ_DEDUP_WINDOW_SECONDS, REQUESTS_STREAM, DLQ_STREAM, MAX_DLQ_RETRIES } from '../../constants'

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

export async function retryFromDLQ(
  redis: Redis,
  apiName: string,
  jobId: string,
  query: string,
  retryCount: number,
  streamId: string,
): Promise<{ success: boolean; error?: string }> {
  if (retryCount >= MAX_DLQ_RETRIES) {
    return { success: false, error: 'Max retries exceeded' }
  }

  const dlqStream = `${apiName}-dlq`
  try {
    // Get apiName from the DLQ entry
    const entry = await redis.xrange(dlqStream, streamId, streamId, 'COUNT', 1)
    if (!entry || !entry.length) {
      return { success: false, error: 'DLQ entry not found' }
    }

    const [, fields] = entry[0]
    const entryApiName = fields.find(f => f[0] === 'apiName')?.[1] || apiName

    // Reconstruct original message for REQUESTS_STREAM with backoff
    const newRetryCount = retryCount + 1
    const backoffDelay = Math.min(1000 * Math.pow(2, newRetryCount), 60000)

    await redis.xadd(
      REQUESTS_STREAM,
      '*',
      'jobId',
      jobId,
      'query',
      query,
      'apiName',
      entryApiName,
      'retryCount',
      newRetryCount.toString(),
      'backoffDelay',
      backoffDelay.toString(),
    )

    // Delete from DLQ after successful XADD
    await redis.xdel(dlqStream, streamId)

    return { success: true }
  } catch (err) {
    console.error(`Retry from DLQ failed for job ${jobId}: ${err.message}`)
    return { success: false, error: err.message }
  }
}
