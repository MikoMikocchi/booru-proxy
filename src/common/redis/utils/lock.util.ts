import { Injectable, Logger, Inject } from '@nestjs/common'
import { v4 as uuidv4 } from 'uuid'
import { Redis as RedisType } from 'ioredis'

interface ExtendedRedis extends RedisType {
  defineCommand(
    name: string,
    definition: { numberOfKeys: number; lua: string },
  ): this
  extendLock(
    key: string,
    lockValue: string,
    ttlSeconds: number,
  ): Promise<number>
  releaseLock(key: string, lockValue: string): Promise<number>
}

@Injectable()
export class LockUtil {
  private readonly logger = new Logger(LockUtil.name)

  private readonly extendLockScript = `
    local key = KEYS[1]
    local currentValue = redis.call('GET', key)
    if currentValue == ARGV[1] then
      return redis.call('EXPIRE', key, ARGV[2])
    else
      return 0
    end
  ` as const

  private readonly releaseLockScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  ` as const

  constructor(@Inject('REDIS_CLIENT') private readonly redis: ExtendedRedis) {
    this.redis.defineCommand('extendLock', {
      numberOfKeys: 1,
      lua: this.extendLockScript,
    })

    this.redis.defineCommand('releaseLock', {
      numberOfKeys: 1,
      lua: this.releaseLockScript,
    })
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const lockValue = uuidv4()
    const result = await this.redis.set(key, lockValue, 'EX', ttlSeconds, 'NX')

    if (result === 'OK') {
      this.logger.debug(`Lock acquired for key: ${key}`)
      return lockValue
    }

    return null
  }

  async extendLock(
    key: string,
    lockValue: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const result = await this.redis.extendLock(key, lockValue, ttlSeconds)
      const success = result === 1

      if (success) {
        this.logger.debug(`Lock extended for key: ${key}`)
      } else {
        this.logger.warn(`Failed to extend lock for key: ${key} (not owned)`)
      }

      return success
    } catch (error) {
      this.logger.error(`Error extending lock for key ${key}:`, error as Error)
      return false
    }
  }

  async releaseLock(key: string, lockValue: string): Promise<boolean> {
    try {
      const result = await this.redis.releaseLock(key, lockValue)
      const success = result === 1

      if (success) {
        this.logger.debug(`Lock released for key: ${key}`)
      } else {
        this.logger.debug(`Lock not released for key: ${key} (not owned)`)
      }

      return success
    } catch (error) {
      this.logger.error(`Error releasing lock for key ${key}:`, error as Error)
      return false
    }
  }

  async withLock<T>(
    key: string,
    ttlSeconds: number,
    operation: () => Promise<T>,
    heartbeatIntervalMs = 10000,
  ): Promise<T | null> {
    const lockValue = await this.acquireLock(key, ttlSeconds)
    if (!lockValue) {
      this.logger.warn(
        `Failed to acquire lock for key: ${key}, skipping operation`,
      )
      return null
    }

    const heartbeatInterval = this.startHeartbeat(
      key,
      lockValue,
      ttlSeconds,
      heartbeatIntervalMs,
    )

    try {
      return await operation()
    } catch (error) {
      this.logger.error(
        `Error in locked operation for key ${key}:`,
        error as Error,
      )
      throw error
    } finally {
      clearInterval(heartbeatInterval)
      await this.releaseLock(key, lockValue)
    }
  }

  private startHeartbeat(
    key: string,
    lockValue: string,
    ttlSeconds: number,
    intervalMs: number,
  ): NodeJS.Timeout {
    return setInterval(() => {
      this.extendLock(key, lockValue, ttlSeconds).catch(error => {
        this.logger.warn(
          `Heartbeat failed for lock: ${key}, operation may be interrupted:`,
          error as Error,
        )
      })
    }, intervalMs)
  }
}
