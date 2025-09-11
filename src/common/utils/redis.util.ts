import { URL } from 'url'

export function parseRedisUrl(redisUrl: string): URL {
  try {
    const url = new URL(redisUrl)
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error('Invalid protocol for Redis URL. Must be redis: or rediss:')
    }
    return url
  } catch (error) {
    throw new Error('Invalid Redis URL format')
  }
}
