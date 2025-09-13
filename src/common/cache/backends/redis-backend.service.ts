import { Injectable, Inject } from '@nestjs/common'
import { ICacheBackend } from '../interfaces/icache-backend.interface'

@Injectable()
export class RedisBackendService implements ICacheBackend {
  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: any) {}

  async get(key: string): Promise<any> {
    try {
      const data = await this.redisClient.get(key)
      return data ? JSON.parse(data) : null
    } catch (error) {
      console.error(`Redis get error for key ${key}:`, error)
      throw error
    }
  }

  async setex(key: string, seconds: number, value: any): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value)
      await this.redisClient.setex(key, seconds, serializedValue)
    } catch (error) {
      console.error(`Redis setex error for key ${key}:`, error)
      throw error
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redisClient.del(key)
    } catch (error) {
      console.error(`Redis del error for key ${key}:`, error)
      throw error
    }
  }

  async invalidate(pattern?: string): Promise<number> {
    try {
      if (pattern) {
        const keys = await this.redisClient.keys(pattern)
        if (keys.length > 0) {
          return await this.redisClient.del(keys)
        }
        return 0
      } else {
        // Invalidate all keys (be careful in production)
        const keys = await this.redisClient.keys('*')
        if (keys.length > 0) {
          return await this.redisClient.del(keys)
        }
        return 0
      }
    } catch (error) {
      console.error('Redis invalidate error:', error)
      throw error
    }
  }

  async getStats(): Promise<any> {
    try {
      const info = await this.redisClient.info()
      // Parse relevant stats
      const stats = {
        connected_clients: info.connected_clients,
        used_memory: info.used_memory,
        used_memory_human: info.used_memory_human,
        total_commands_processed: info.total_commands_processed,
        uptime_in_seconds: info.uptime_in_seconds,
        uptime_in_days: info.uptime_in_days,
      }
      return stats
    } catch (error) {
      console.error('Redis stats error:', error)
      throw error
    }
  }
}
