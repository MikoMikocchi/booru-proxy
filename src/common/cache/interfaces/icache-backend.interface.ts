export interface ICacheBackend {
  get(key: string): Promise<unknown>
  setex(key: string, seconds: number, value: unknown): Promise<void>
  del(key: string): Promise<void>
  invalidate(pattern?: string): Promise<number>
  getStats(): Promise<unknown>
}
