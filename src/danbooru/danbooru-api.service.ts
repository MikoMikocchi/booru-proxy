import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { plainToClass } from 'class-transformer'
import { validate, ValidationError } from 'class-validator'
import { DanbooruPost } from './dto/danbooru-post.class'
import { API_TIMEOUT_MS } from '../common/constants'
import xss, { escapeHtml } from 'xss'
import { BaseApiService, ApiConfig } from '../common/api/base-api.service'

interface DanbooruApiResponse {
  data: DanbooruPost[]
}

@Injectable()
export class DanbooruApiService extends BaseApiService {
  private readonly login: string
  private readonly apiKey: string

  constructor(configService: ConfigService) {
    super(configService)
    this.login = configService.get<string>('DANBOORU_LOGIN') ?? ''
    this.apiKey = configService.get<string>('DANBOORU_API_KEY') ?? ''
    if (!this.login || !this.apiKey) {
      throw new Error('DANBOORU_LOGIN and DANBOORU_API_KEY must be set')
    }
  }

  protected getApiConfig(): ApiConfig {
    return {
      baseUrl: 'https://danbooru.donmai.us',
      timeout: API_TIMEOUT_MS,
      auth: {
        username: this.login,
        password: this.apiKey,
      },
      retryAttempts: 3, // Explicitly set for axios-retry
    }
  }

  protected getBaseEndpoint(): string {
    return '/posts.json'
  }

  // Override sanitizeResponse for Danbooru-specific sanitization
  protected sanitizeResponse(data: any): any {
    const sanitized = super.sanitizeResponse(data)

    // Additional Danbooru-specific tag sanitization using xss library
    if (sanitized.tag_string_general) {
      sanitized.tag_string_general = this.sanitizeTags(
        sanitized.tag_string_general,
      )
    }
    if (sanitized.tag_string_copyright) {
      sanitized.tag_string_copyright = this.sanitizeTags(
        sanitized.tag_string_copyright,
      )
    }

    return sanitized
  }

  private sanitizeTags(tags: string): string {
    if (!tags) return ''
    // Strict sanitization: strip all HTML/JS tags to prevent XSS in user-generated Danbooru tags
    // Use empty whiteList to remove all tags, escape attributes, and strip dangerous elements
    return xss(tags, {
      whiteList: {}, // No allowed tags - full stripping
      escapeHtml, // Escape HTML entities using xss's escapeHtml function
      stripIgnoreTag: true,
      stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
    })
  }

  async fetchPosts(
    query: string,
    limit: number = 1,
    random: boolean = true,
  ): Promise<DanbooruPost | null> {
    // Use inherited fetchPosts from BaseApiService, which handles caching, logging, and sanitization
    const postData = await super.fetchPosts(query, limit, random)

    if (!postData) {
      return null
    }

    // Additional Danbooru-specific validation
    const post = plainToClass(DanbooruPost, postData)
    const errors: ValidationError[] = await validate(post, {
      forbidNonWhitelisted: true,
    })
    if (errors.length > 0) {
      this.logger.warn(
        `Validation errors in Danbooru response: ${JSON.stringify(errors)}`,
      )
      return null
    }

    return post
  }
}
