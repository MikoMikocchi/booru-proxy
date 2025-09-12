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
export const QUERY_LOCK_TIMEOUT_SECONDS = 30 // Reduced from 300s to 30s for faster lock release
export const DLQ_DEDUP_WINDOW_SECONDS = 3600 // 1 hour

// Cache key prefixes and patterns
export const CACHE_PREFIX = 'cache'
export const DANBOORU_API_PREFIX = 'danbooru'
export const POSTS_RESOURCE = 'posts'
export const RANDOM_SUFFIX = 'random'
export const TAG_SUFFIX = 'tag'
export const LIMIT_SUFFIX = 'limit'
export const RANDOM_SEED_SUFFIX = 'seed'

// Cache invalidation patterns
export const DANBOORU_POSTS_PATTERN = `${CACHE_PREFIX}:${DANBOORU_API_PREFIX}:${POSTS_RESOURCE}:*`
export const DANBOORU_TAG_PATTERN = `${CACHE_PREFIX}:${DANBOORU_API_PREFIX}:${POSTS_RESOURCE}:*:${TAG_SUFFIX}:*`
export const DANBOORU_RANDOM_PATTERN = `${CACHE_PREFIX}:${DANBOORU_API_PREFIX}:${POSTS_RESOURCE}:*:${RANDOM_SUFFIX}:*`
export const DANBOORU_ALL_PATTERN = `${CACHE_PREFIX}:${DANBOORU_API_PREFIX}:*`

/**
 * Generate stream names for API providers
 * @param apiPrefix - API prefix (e.g., 'danbooru', 'gelbooru')
 * @param type - Stream type (e.g., 'requests', 'responses', 'dlq')
 * @returns Stream name in format: `${apiPrefix}:${type}`
 */
export function getStreamName(apiPrefix: string, type: string): string {
  return `${apiPrefix}:${type}`;
}
