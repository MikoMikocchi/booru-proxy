import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { plainToClass } from 'class-transformer'
import { validate, ValidationError } from 'class-validator'
import { DanbooruPost } from './dto/danbooru-post.class'
import { API_TIMEOUT_MS } from '../common/constants'
import xss, { escapeHtml } from 'xss'
import { BaseApiService, ApiConfig } from '../common/api/base-api.service'

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
  protected sanitizeResponse(data: unknown): Record<string, unknown> {
    const sanitized = super.sanitizeResponse(data)

    // Comprehensive Danbooru-specific sanitization using xss library
    // Sanitize all potential string fields that could contain user-generated content
    const stringFields = [
      'tag_string_general',
      'tag_string_artist',
      'tag_string_copyright',
      'tag_string_character',
      'source',
      'description',
      'commentary_title',
      'commentary_desc',
      'file_url',
      'large_file_url',
      'preview_file_url',
      'sample_file_url',
      'pixiv_id',
      'last_comment_at',
      'created_at',
      'updated_at',
      'pixiv_artist_id',
      'uploader_id',
      'score',
      'fav_count',
      'comment_count',
      'updater_id',
    ] as const

    stringFields.forEach(field => {
      if (sanitized[field] && typeof sanitized[field] === 'string') {
        sanitized[field] = this.sanitizeStringField(sanitized[field])
      }
    })

    return sanitized
  }

  private sanitizeStringField(str: string): string {
    if (!str) return ''

    // Use xss library for comprehensive sanitization
    // Empty whitelist strips all tags, escapeHtml prevents attribute injection
    return xss(str, {
      whiteList: {}, // No allowed tags - complete stripping
      escapeHtml, // Escape HTML entities
      stripIgnoreTag: true,
      stripIgnoreTagBody: [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'svg',
        'img',
      ],
    })
  }

  async fetchPosts(
    query: string,
    limit: number = 1,
    random: boolean = true,
  ): Promise<Record<string, unknown> | null> {
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

    return post as Record<string, unknown>
  }
}
