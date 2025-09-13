import { Injectable, Inject } from '@nestjs/common'
import { ICacheBackend } from '../interfaces/icache-backend.interface'
import Redis from 'ioredis'
import { Logger } from '@nestjs/common'

@Injectable()
export class RedisBackendService implements ICacheBackend {
  private readonly logger = new Logger(RedisBackendService.name)

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  async get(key: string): Promise<unknown> {
    try {
      const data = await this.redisClient.get(key)
      return data ? (JSON.parse(data) as unknown) : null
    } catch (error: unknown) {
      this.logger.error(`Redis get error for key ${key}:`, error as Error)
      throw error
    }
  }

  async setex(key: string, seconds: number, value: unknown): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value)
      await this.redisClient.setex(key, seconds, serializedValue)
    } catch (error: unknown) {
      this.logger.error(`Redis setex error for key ${key}:`, error as Error)
      throw error
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redisClient.del(key)
    } catch (error: unknown) {
      this.logger.error(`Redis del error for key ${key}:`, error as Error)
      throw error
    }
  }

  async invalidate(pattern?: string): Promise<number> {
    try {
      let keys: string[]
      if (pattern) {
        keys = await this.redisClient.keys(pattern)
      } else {
        // Invalidate all keys (be careful in production)
        keys = await this.redisClient.keys('*')
      }
      if (keys.length > 0) {
        return await this.redisClient.del(keys)
      }
      return 0
    } catch (error: unknown) {
      this.logger.error('Redis invalidate error:', error as Error)
      throw error
    }
  }

  async getStats(): Promise<unknown> {
    try {
      const infoStr = await this.redisClient.info()
      const info = this.parseRedisInfo(infoStr)
      // Parse relevant stats
      const stats = {
        connected_clients: parseInt(info.connected_clients || '0', 10),
        used_memory: parseInt(info.used_memory || '0', 10),
        used_memory_human: info.used_memory_human || '0',
        total_commands_processed: parseInt(
          info.total_commands_processed || '0',
          10,
        ),
        uptime_in_seconds: parseInt(info.uptime_in_seconds || '0', 10),
        uptime_in_days: parseInt(info.uptime_in_days || '0', 10),
      }
      return stats
    } catch (error: unknown) {
      this.logger.error('Redis stats error:', error as Error)
      throw error
    }
  }

  private parseRedisInfo(infoStr: string): Record<string, string> {
    const info: Record<string, string> = {}
    const lines = infoStr.split('\n')
    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':', 2)
        if (key && value !== undefined) {
          info[key.trim()] = value.trim()
        }
      }
    }
    return info
  }
}
