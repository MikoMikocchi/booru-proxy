import { AxiosInstance } from 'axios'

export interface ApiResponse<T = any> {
  data: T[]
  count?: number
  total?: number
}

export interface ApiConfig {
  baseURL: string
  timeout?: number
  auth?: {
    username: string
    password: string
  }
  retryAttempts?: number
  rateLimit?: {
    perMinute: number
    windowSeconds: number
  }
}

export interface BaseApiService {
  readonly httpClient: AxiosInstance
  fetchPosts(
    query: string,
    limit?: number,
    random?: boolean,
  ): Promise<any | null>
  sanitizeResponse(data: any): any
}

export abstract class BaseApiProvider {
  abstract getApiService(): BaseApiService
  abstract getName(): string
  abstract getStreamNames(): {
    requests: string
    responses: string
    dlq: string
  }
}
