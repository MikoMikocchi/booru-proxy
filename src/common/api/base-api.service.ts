import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import Redis from 'ioredis';
import { ApiResponse, ApiConfig } from './base-api.interface';
import { CacheService } from '../cache/cache.service';

@Injectable()
export abstract class BaseApiService {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly httpClient: AxiosInstance;

  constructor(
    protected configService: ConfigService,
    @Inject('REDIS_CLIENT') protected redis?: Redis,
    @Inject(CacheService) protected cacheService?: CacheService, // Optional cache injection
  ) {
    this.httpClient = axios.create(this.getApiConfig());
    this.setupRetryInterceptor();
  }

  protected abstract getApiConfig(): ApiConfig;
  protected abstract getBaseEndpoint(): string;

  protected setupRetryInterceptor(): void {
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const maxRetries = this.getApiConfig().retryAttempts || 3;
        const config = error.config as any;
        config.retryCount = (config.retryCount || 0) + 1;

        if (
          config.retryCount <= maxRetries &&
          (error.code === 'ECONNABORTED' ||
           (error.response?.status && (error.response.status >= 500 || error.response.status === 429)))
        ) {
          const delay = Math.pow(2, config.retryCount) * 1000 + Math.random() * 1000; // Exponential with jitter
          this.logger.warn(`Retrying ${this.constructor.name} request after ${delay}ms (attempt ${config.retryCount}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.httpClient(config);
        }
        return Promise.reject(error);
      },
    );
  }

  async fetchPosts(query: string, limit = 1, random = true): Promise<any | null> {
    const apiPrefix = this.getName();

    if (this.cacheService && !random) {
      const cached = await this.cacheService.getCachedResponse(apiPrefix, query, random);
      if (cached) {
        this.logger.debug(`${this.constructor.name}: Cache hit for query: ${query}`);
        return cached;
      }
    }

    try {
      this.logger.log(`${this.constructor.name}: Fetching posts for query: ${query}`);
      const endpoint = this.buildEndpoint(query, limit, random);
      const response = await this.httpClient.get<ApiResponse>(endpoint);
      const posts = response.data?.data;

      if (!posts || posts.length === 0) {
        this.logger.warn(`${this.constructor.name}: No posts found for query: ${query}`);
        return null;
      }

      const post = posts[0];
      const sanitizedPost = this.sanitizeResponse(post);

      if (!random && this.cacheService) {
        await this.cacheService.setCache(apiPrefix, query, sanitizedPost, random);
      }

      return sanitizedPost;
    } catch (error) {
      this.logger.error(`${this.constructor.name}: API error for query ${query}: ${(error as Error).message}`, error.stack);
      return null;
    }
  }

  protected buildEndpoint(query: string, limit: number, random: boolean): string {
    let endpoint = `${this.getBaseEndpoint()}?tags=${encodeURIComponent(query)}&limit=${limit}`;
    if (random) {
      endpoint += '&random=true';
    }
    return endpoint;
  }

  protected getCacheKey(apiPrefix: string, query: string, random: boolean): string {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `${apiPrefix}:${normalized}|random=${random ? 1 : 0}`;
    return key;
  }

  protected async cacheResponse(apiPrefix: string, query: string, data: any, random: boolean, ttl?: number): Promise<void> {
    if (this.cacheService) {
      await this.cacheService.setCache(apiPrefix, query, data, random, ttl);
    } else if (this.redis) {
      const key = this.getCacheKey(apiPrefix, query, random);
      const expiresIn = ttl || this.configService.get<number>('CACHE_TTL_SECONDS') || 3600;
      await this.redis.setex(key, expiresIn, JSON.stringify(data));
      this.logger.debug(`${this.constructor.name}: Direct Redis cache for key: ${key}`);
    }
  }

  protected sanitizeResponse(data: any): any {
    // Default sanitization - override in subclasses for specific fields
    if (typeof data === 'object') {
      const sanitized = { ...data };
      // Sanitize common string fields (override in child classes)
      ['tag_string_general', 'tag_string_artist', 'tag_string_copyright', 'source'].forEach(field => {
        if (typeof sanitized[field] === 'string') {
          sanitized[field] = this.sanitizeString(sanitized[field]);
        }
      });
      return sanitized;
    }
    return data;
  }

  protected sanitizeString(str: string): string {
    // Basic XSS protection - use xss library in production
    return str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').trim();
  }

  protected getName(): string {
    return this.constructor.name.replace('ApiService', '');
  }
}
