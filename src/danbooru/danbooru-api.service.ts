import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios, { AxiosInstance, AxiosError } from 'axios'
import { plainToClass } from 'class-transformer'
import { validate, ValidationError } from 'class-validator'
import { DanbooruPost } from './interfaces/danbooru-post.interface'
import { API_TIMEOUT_MS } from '../common/constants'
import xss from 'xss'

interface DanbooruApiResponse {
	data: DanbooruPost[]
}

@Injectable()
export class DanbooruApiService {
	private readonly logger = new Logger(DanbooruApiService.name)
	private readonly axiosInstance: AxiosInstance
	private readonly login: string
	private readonly apiKey: string

	constructor(private configService: ConfigService) {
		this.login = this.configService.get<string>('DANBOORU_LOGIN') ?? ''
		this.apiKey = this.configService.get<string>('DANBOORU_API_KEY') ?? ''
		if (!this.login || !this.apiKey) {
			throw new Error('DANBOORU_LOGIN and DANBOORU_API_KEY must be set')
		}

		this.axiosInstance = axios.create({
			baseURL: 'https://danbooru.donmai.us',
			timeout: API_TIMEOUT_MS,
			auth: {
				username: this.login,
				password: this.apiKey,
			},
		})

		// Manual retry interceptor for network errors (up to 3 attempts)
		this.axiosInstance.interceptors.response.use(
			response => response,
			async (error: AxiosError) => {
				const maxRetries = 3
				const config = error.config as any // Type assertion for retryCount
				const retryCount = config.retryCount || 0
				if (
					retryCount < maxRetries &&
					(error.code === 'ECONNABORTED' ||
						(error.response?.status && error.response.status >= 500))
				) {
					config.retryCount = retryCount + 1
					await new Promise(resolve => setTimeout(resolve, 1000 * retryCount))
					return this.axiosInstance(config)
				}
				return Promise.reject(error)
			},
		)
	}

	async fetchPosts(
		query: string,
		limit: number = 1,
		random: boolean = true,
	): Promise<DanbooruPost | null> {
		this.logger.log(`Fetching posts for query: ${query}`)
		try {
			let url = `/posts.json?tags=${encodeURIComponent(query)}&limit=${limit}`
			if (random) {
				url += '&random=true'
			}
			const response = await this.axiosInstance.get<DanbooruApiResponse>(url)

			const apiResponse = response.data
			const posts = apiResponse.data
			if (!posts || posts.length === 0) {
				return null
			}

			// Runtime validation of first post
			const rawPost = posts[0]
			const post = plainToClass(Object, rawPost) as unknown as DanbooruPost
			const errors: ValidationError[] = await validate(post, {
				forbidNonWhitelisted: true,
			})
			if (errors.length > 0) {
				this.logger.warn(
					`Validation errors in Danbooru response: ${JSON.stringify(errors)}`,
				)
				return null
			}

			// Sanitize tags (basic for now, improve later)
			post.tag_string_general = this.sanitizeTags(post.tag_string_general)
			post.tag_string_copyright = this.sanitizeTags(post.tag_string_copyright)

			return post
		} catch (error) {
			this.logger.error(
				`API error for query ${query}: ${(error as Error).message}`,
			)
			return null
		}
	}

	private sanitizeTags(tags: string): string {
		if (!tags) return ''
		return xss(tags, {
			whiteList: {}, // Strict mode, no HTML tags allowed
		})
	}
}
