import Redis from 'ioredis'
import {
  DLQ_DEDUP_WINDOW_SECONDS,
  REQUESTS_STREAM,
  DLQ_STREAM,
  MAX_DLQ_RETRIES,
} from '../../constants'
import { encrypt, decrypt } from '../../crypto/crypto.util'
import * as crypto from 'crypto'

/**
 * ENHANCED DEDUPLICATION STRATEGY
 *
 * This module implements a multi-layered deduplication system for queue processing:
 *
 * 1. CROSS-JOB DEDUPLICATION (Primary Protection)
 *    - Uses Redis SET with TTL (`dedup:job:${jobId}`) to prevent the same jobId
 *      from being processed multiple times across different streams or instances
 *    - TTL matches DLQ_DEDUP_WINDOW_SECONDS (1 hour by default)
 *    - Short-circuits dedupCheck immediately if job already exists
 *
 * 2. DLQ TIMESTAMP PRECISION SCANNING (Secondary Protection)
 *    - Replaces inefficient XREAD + COUNT limit with XRANGE for exact timestamp range
 *    - Scans from (now - window - 1ms) to now for precise coverage
 *    - Uses COUNT 100 limit for performance but covers exact time window
 *    - Detects identical queries in recent DLQ failures to prevent retry loops
 *
 * 3. INTEGRATION FLOW
 *    - Consumer calls dedupCheck(jobId, query) before processing
 *    - If cross-job duplicate: immediate skip with error response
 *    - If DLQ query duplicate: skip to prevent processing failed queries again
 *    - Only processes unique jobs/queries, reducing API load and preventing loops
 *
 * 4. ERROR HANDLING
 *    - All failures return false (allow processing) to avoid false negatives
 *    - Logs detailed duplicate detection for monitoring
 *    - Graceful degradation if Redis unavailable
 *
 * 5. PERFORMANCE CONSIDERATIONS
 *    - Cross-job check: O(1) Redis EXISTS + SETEX
 *    - DLQ scan: O(N) where N <= 100 (XRANGE COUNT limit)
 *    - Timestamp-based: No need to scan entire stream history
 *
 * This strategy provides robust protection against duplicates while maintaining
 * high throughput and precise failure detection.
 */

export async function addToDLQ(
  redis: Redis,
  apiName: string,
  jobId: string,
  errorMessage: string,
  plaintextQuery: string,
  retryCount = 0,
  encryptionKey?: string,
): Promise<void> {
  const encryptionKeyFinal = encryptionKey || process.env.ENCRYPTION_KEY
  if (!encryptionKeyFinal) {
    throw new Error('ENCRYPTION_KEY is required for DLQ encryption')
  }

  const encryptedQuery = encrypt(plaintextQuery, encryptionKeyFinal)
  const queryHash = crypto
    .createHash('sha256')
    .update(plaintextQuery)
    .digest('hex')

  const dlqStream = `${apiName}-dlq`
  await redis.xadd(
    dlqStream,
    '*',
    'jobId',
    jobId,
    'error',
    errorMessage,
    'encryptedQuery',
    encryptedQuery,
    'queryHash',
    queryHash,
    'retryCount',
    retryCount.toString(),
    'apiName',
    apiName,
  )
}

// Enhanced deduplication check for DLQ with XRANGE precision and cross-job protection
// Scans timestamp range for matching queries and checks job-level deduplication set
export async function dedupCheck(
  redis: Redis,
  apiName: string,
  plaintextQuery: string,
  jobId: string,
  encryptionKey?: string,
): Promise<boolean> {
  const encryptionKeyFinal = encryptionKey || process.env.ENCRYPTION_KEY
  const queryHash = crypto
    .createHash('sha256')
    .update(plaintextQuery)
    .digest('hex')

  const dlqStream = `${apiName}-dlq`
  const windowMs = DLQ_DEDUP_WINDOW_SECONDS * 1000
  const now = Date.now()
  const startId = (now - windowMs - 1).toString() // XRANGE start: window ago minus 1ms for full coverage
  const endId = now.toString() // XRANGE end: current timestamp

  try {
    // 1. Cross-job deduplication: Check if this jobId was already processed
    const jobDedupKey = `dedup:job:${jobId}`
    const jobExists = await redis.exists(jobDedupKey)
    if (jobExists) {
      console.log(`Cross-job duplicate detected for jobId: ${jobId}`)
      return true
    }

    // Set job dedup marker with TTL for cross-job protection (same window as DLQ check)
    await redis.setex(jobDedupKey, DLQ_DEDUP_WINDOW_SECONDS, '1')

    // 2. DLQ query duplicate check using hash comparison
    const entries = await redis.xrange(dlqStream, startId, endId, 'COUNT', 100)

    if (!entries || !entries.length) {
      return false
    }

    for (const [, fields] of entries) {
      const entryQueryHash = fields.find(f => f[0] === 'queryHash')?.[1]
      if (entryQueryHash === queryHash) {
        console.log(
          `DLQ query hash duplicate found: ${queryHash.slice(0, 16)}... within window`,
        )
        return true // Duplicate query hash found in recent DLQ
      }
    }

    return false
  } catch (error) {
    console.error(
      `Enhanced DLQ dedup check failed for job ${jobId}: ${error.message}`,
    )
    return false // On error, don't skip - better to process than risk missing
  }
}

export async function moveToDeadQueue(
  redis: Redis,
  apiName: string,
  jobId: string,
  errorMessage: string,
  plaintextQuery: string,
  finalError?: string,
  encryptionKey?: string,
): Promise<void> {
  const encryptionKeyFinal = encryptionKey || process.env.ENCRYPTION_KEY
  if (!encryptionKeyFinal) {
    throw new Error('ENCRYPTION_KEY is required for Dead Queue encryption')
  }

  const encryptedQuery = encrypt(plaintextQuery, encryptionKeyFinal)
  const queryHash = crypto
    .createHash('sha256')
    .update(plaintextQuery)
    .digest('hex')

  const deadQueueStream = `${apiName}-dead`
  await redis.xadd(
    deadQueueStream,
    '*',
    'jobId',
    jobId,
    'error',
    errorMessage,
    'encryptedQuery',
    encryptedQuery,
    'queryHash',
    queryHash,
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
  plaintextQuery: string,
  retryCount: number,
  streamId: string,
  encryptionKey?: string,
): Promise<{ success: boolean; error?: string }> {
  const encryptionKeyFinal = encryptionKey || process.env.ENCRYPTION_KEY
  if (!encryptionKeyFinal) {
    return { success: false, error: 'ENCRYPTION_KEY is required for retry' }
  }

  if (retryCount >= MAX_DLQ_RETRIES) {
    return { success: false, error: 'Max retries exceeded' }
  }

  const dlqStream = `${apiName}-dlq`
  try {
    // Get DLQ entry to extract metadata
    const entry = await redis.xrange(dlqStream, streamId, streamId, 'COUNT', 1)
    if (!entry || !entry.length) {
      return { success: false, error: 'DLQ entry not found' }
    }

    const [, fields] = entry[0]
    const entryApiName = fields.find(f => f[0] === 'apiName')?.[1] || apiName
    const storedEncryptedQuery = fields.find(
      f => f[0] === 'encryptedQuery',
    )?.[1]
    const storedQueryHash = fields.find(f => f[0] === 'queryHash')?.[1]

    if (!storedEncryptedQuery) {
      return { success: false, error: 'No encrypted query found in DLQ entry' }
    }

    // Decrypt the query from DLQ
    let decryptedQuery: string
    try {
      decryptedQuery = decrypt(storedEncryptedQuery, encryptionKeyFinal)
    } catch (decryptError) {
      console.error(
        `Failed to decrypt DLQ entry for job ${jobId}: ${decryptError.message}`,
      )
      return { success: false, error: 'Failed to decrypt DLQ entry' }
    }

    // Verify query integrity via hash (optional security check)
    const decryptedHash = crypto
      .createHash('sha256')
      .update(decryptedQuery)
      .digest('hex')
    if (storedQueryHash !== decryptedHash) {
      console.error(`Query hash mismatch in DLQ retry for job ${jobId}`)
      return { success: false, error: 'Query integrity check failed' }
    }

    // Use decrypted query for deduplication check
    const isDuplicate = await dedupCheck(
      redis,
      entryApiName,
      decryptedQuery,
      jobId,
      encryptionKeyFinal,
    )
    if (isDuplicate) {
      console.log(`Skipping retry for duplicate job ${jobId}`)
      return { success: false, error: 'Duplicate job detected during retry' }
    }

    // Reconstruct original message for REQUESTS_STREAM with backoff (encrypt query)
    const newRetryCount = retryCount + 1
    const backoffDelay = Math.min(1000 * Math.pow(2, newRetryCount), 60000)
    const encryptedQueryForStream = encrypt(decryptedQuery, encryptionKeyFinal)
    const queryHashForStream = crypto
      .createHash('sha256')
      .update(decryptedQuery)
      .digest('hex')

    await redis.xadd(
      REQUESTS_STREAM,
      '*',
      'jobId',
      jobId,
      'encryptedQuery',
      encryptedQueryForStream,
      'queryHash',
      queryHashForStream,
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
