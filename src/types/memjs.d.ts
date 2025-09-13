declare module 'memjs' {
  export interface ClientOptions {
    expires?: number
    username?: string
    password?: string
  }

  export interface Client {
    get(key: string): Promise<string | null>
    set(key: string, value: string, options?: ClientOptions): Promise<void>
    delete(key: string): Promise<void>
    stats(): Promise<any>
    quit(): void
  }

  export const Client: {
    create(servers: string, options?: any): Client
  }
}
