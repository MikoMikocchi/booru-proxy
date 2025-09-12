export interface ICacheBackend {
  get(key: string): Promise<any>;
  setex(key: string, seconds: number, value: any): Promise<void>;
  del(key: string): Promise<void>;
  invalidate(pattern?: string): Promise<number>;
  getStats(): Promise<any>;
}
