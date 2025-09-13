export interface QueueConfig {
  name: string
  prefix: string
  concurrency?: number
  removeOnComplete?: boolean
  removeOnFail?: boolean
  defaultJobOptions?: Record<string, unknown>
}

export interface IQueueProvider {
  getQueueConfig(): QueueConfig
  getStreamNames(): string[]
}
