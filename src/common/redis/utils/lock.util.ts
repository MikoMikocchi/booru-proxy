import { Injectable, Logger, Inject } from '@nestjs/common'
import { v4 as uuidv4 } from 'uuid'
import { Redis as RedisType } from 'ioredis'

interface ExtendedRedis extends RedisType {
  defineCommand(
    name: string,
    definition: { numberOfKeys: number; lua: string },
  ): ExtendedRedis
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
  `

  private readonly releaseLockScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `

  constructor(@Inject('REDIS_CLIENT') private readonly redis: ExtendedRedis) {
    // Define Lua scripts as commands for ioredis
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
    const lockValue = uuidv4() // Unique identifier for this lock instance
    const result = await this.redis.set(key, lockValue, 'EX', ttlSeconds, 'NX')

    if (result === 'OK') {
      this.logger.debug(`Lock acquired for key: ${key}`)
      return lockValue
    }

    return null // Lock not acquired
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
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      this.logger.error(`Error extending lock for key ${key}: ${errorMessage}`)
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
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      this.logger.error(`Error releasing lock for key ${key}: ${errorMessage}`)
      return false
    }
  }

  // Convenience method to acquire lock with heartbeat
  async withLock<T>(
    key: string,
    ttlSeconds: number,
    operation: () => Promise<T>,
    heartbeatIntervalMs: number = 10000, // 10 seconds default
  ): Promise<T | null> {
    let lockValue: string | null = null
    let heartbeatInterval: NodeJS.Timeout | null = null

    try {
      // Acquire lock
      lockValue = await this.acquireLock(key, ttlSeconds)
      if (!lockValue) {
        this.logger.warn(
          `Failed to acquire lock for key: ${key}, skipping operation`,
        )
        return null // Fallback: return null to indicate "try later"
      }

      // Start heartbeat to extend lock periodically
      heartbeatInterval = setInterval(() => {
        if (lockValue) {
          this.extendLock(key, lockValue, ttlSeconds).catch(
            (error: unknown) => {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              this.logger.warn(
                `Heartbeat failed for lock: ${key}, operation may be interrupted: ${errorMessage}`,
              )
            },
          )
          // Note: We don't clear interval here as operation might still complete
        }
      }, heartbeatIntervalMs)

      // Execute the main operation
      const result = await operation()
      return result
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      this.logger.error(
        `Error in locked operation for key ${key}: ${errorMessage}`,
      )
      throw error
    } finally {
      // Stop heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
      }

      // Release lock if we own it
      if (lockValue) {
        await this.releaseLock(key, lockValue)
      }
    }
  }
}
