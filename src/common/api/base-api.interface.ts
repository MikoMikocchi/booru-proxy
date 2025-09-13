export interface ApiConfig {
  baseUrl: string
  apiKey?: string
  timeout?: number
  rateLimit?: number
  cacheTtl?: number
  retryAttempts?: number
  auth?: {
    username: string
    password: string
  }
}

export interface ApiResponse<T = unknown> {
  data: T
  metadata?: {
    total?: number
    limit?: number
    offset?: number
    next?: string
    prev?: string
  }
  errors?: string[]
  status: number
  timestamp: string
}

export interface IApiProvider {
  getApiService(): unknown
  getName(): string
  getConfig(): ApiConfig
  getStreamNames(): string[]
  sanitizeResponse(response: ApiResponse<unknown>): ApiResponse<unknown>
}
