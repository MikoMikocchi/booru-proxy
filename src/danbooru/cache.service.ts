import { Injectable, Inject, Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { ConfigService } from '@nestjs/config'
import { DanbooruSuccessResponse } from './interfaces/danbooru.interface'
import * as crypto from 'crypto'

@Injectable()
export class CacheService {
	private readonly logger = new Logger(CacheService.name)
	private readonly ttl: number

	constructor(
		@Inject('REDIS_CLIENT') private readonly redis: Redis,
		private configService: ConfigService,
	) {
		this.ttl = this.configService.get<number>('CACHE_TTL_SECONDS') || 3600
	}

	async getCachedResponse(
		query: string,
	): Promise<DanbooruSuccessResponse | null> {
		const key = this.getCacheKey(query)
		const cached = await this.redis.get(key)
		if (cached) {
			return JSON.parse(cached) as DanbooruSuccessResponse
		}
		return null
	}

	async setCache(
		query: string,
		response: DanbooruSuccessResponse,
	): Promise<void> {
		const key = this.getCacheKey(query)
		await this.redis.setex(key, this.ttl, JSON.stringify(response))
		this.logger.log(`Cached response for query: ${query}`)
	}

	private getCacheKey(query: string): string {
		// Normalize query for non-random caching: trim, lowercase, normalize spaces
		const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ').trim()
		const hash = crypto.createHash('md5').update(normalizedQuery).digest('hex')
		return `cache:danbooru:${hash}`
	}
}
