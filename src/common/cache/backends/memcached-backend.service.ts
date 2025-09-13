import { Injectable } from '@nestjs/common'
import { ICacheBackend } from '../interfaces/icache-backend.interface'
import * as memjs from 'memjs'

@Injectable()
export class MemcachedBackendService implements ICacheBackend {
  private client: any

  constructor() {
    this.client = memjs.Client.create('localhost:11211')
  }

  async get(key: string): Promise<any> {
    try {
      const value = await this.client.get(key)
      return value ? JSON.parse(value) : null
    } catch (error) {
      console.error(`Memcached get error for key ${key}:`, error)
      throw error
    }
  }

  async setex(key: string, seconds: number, value: any): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value)
      await this.client.set(key, serializedValue, { expires: seconds })
    } catch (error) {
      console.error(`Memcached setex error for key ${key}:`, error)
      throw error
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.delete(key)
    } catch (error) {
      console.error(`Memcached del error for key ${key}:`, error)
      throw error
    }
  }

  async invalidate(pattern?: string): Promise<number> {
    try {
      // Memcached limitation: cannot invalidate by pattern
      // This implementation returns 0 as per requirements
      // To actually clear cache, you would need to track all keys
      return 0
    } catch (error) {
      console.error('Memcached invalidate error:', error)
      throw error
    }
  }

  async getStats(): Promise<any> {
    try {
      // Memcached stats via telnet or stats command
      const stats = await this.client.stats()
      return {
        uptime: stats.uptime,
        version: stats.version,
        curr_items: stats.curr_items,
        total_items: stats.total_items,
        cmd_get: stats.cmd_get,
        cmd_set: stats.cmd_set,
        get_hits: stats.get_hits,
        get_misses: stats.get_misses,
        evictions: stats.evictions,
        bytes: stats.bytes,
      }
    } catch (error) {
      console.error('Memcached stats error:', error)
      // Return empty stats object instead of throwing
      return {}
    }
  }

  // Cleanup on module destruction
  onModuleDestroy() {
    if (this.client) {
      this.client.quit()
    }
  }
}
