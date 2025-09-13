declare module 'memjs' {
  export interface ClientOptions {
    expires?: number
    username?: string
    password?: string
  }

  export interface Stats {
    uptime: number
    version: string
    curr_items: number
    total_items: number
    cmd_get: number
    cmd_set: number
    get_hits: number
    get_misses: number
    evictions: number
    bytes: number
  }

  export interface Client {
    get(key: string): Promise<string | null>
    set(key: string, value: string, options?: ClientOptions): Promise<void>
    delete(key: string): Promise<void>
    stats(): Promise<Stats>
    quit(): void
  }

  export const Client: {
    create(servers: string, options?: ClientOptions): Client
  }
}
