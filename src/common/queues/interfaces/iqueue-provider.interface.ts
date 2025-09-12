export interface QueueConfig {
  name: string;
  prefix: string;
  concurrency?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  defaultJobOptions?: any;
}

export interface IQueueProvider {
  getQueueConfig(): QueueConfig;
  getStreamNames(): string[];
}
