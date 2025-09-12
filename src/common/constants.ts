export const API_TIMEOUT_MS = 10000
export const STREAM_BLOCK_MS = 5000
export const RETRY_DELAY_MS = 5000
export const RATE_LIMIT_PER_MINUTE = 60
export const RATE_WINDOW_SECONDS = 60
export const DEDUP_TTL_SECONDS = 86400
export const MAX_RETRY_ATTEMPTS = 5
export const MAX_BACKOFF_MS = 30000
export const REQUESTS_STREAM = 'danbooru:requests'
export const RESPONSES_STREAM = 'danbooru:responses'
export const DLQ_STREAM = 'danbooru-dlq'
export const DEAD_QUEUE_STREAM = 'danbooru-dead'
export const MAX_DLQ_RETRIES = 5

// Deduplication and locking constants
export const QUERY_LOCK_TIMEOUT_SECONDS = 300 // 5 minutes
export const DLQ_DEDUP_WINDOW_SECONDS = 3600 // 1 hour
