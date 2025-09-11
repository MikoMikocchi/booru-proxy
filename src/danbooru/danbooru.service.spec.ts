import 'reflect-metadata'

/* eslint-disable @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-return,@typescript-eslint/unbound-method,@typescript-eslint/require-await */

import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { DanbooruService } from './danbooru.service'
import axios from 'axios'
import Redis from 'ioredis'
import { plainToClass } from 'class-transformer'
import * as classValidator from 'class-validator'
import {
	DanbooruResponse,
	DanbooruErrorResponse,
} from './interfaces/danbooru.interface'
import {
	API_TIMEOUT_MS,
	STREAM_BLOCK_MS,
	RETRY_DELAY_MS,
	RATE_LIMIT_PER_MINUTE,
	REQUESTS_STREAM,
	RESPONSES_STREAM,
	DLQ_STREAM,
} from '../common/constants'

jest.mock('axios')
jest.mock('ioredis')
jest.mock('class-transformer')

jest.spyOn(classValidator, 'validate').mockResolvedValue([])

describe('DanbooruService', () => {
	let service: DanbooruService
	let mockConfigService: jest.Mocked<ConfigService>
	const mockAxios = axios as jest.Mocked<typeof axios>
	const mockRedisConstructor = Redis as jest.MockedClass<typeof Redis>
	let mockRedisInstance: any

	beforeEach(async () => {
		mockConfigService = {
			get: jest.fn().mockImplementation((key: string): string | null => {
				if (key === 'DANBOORU_LOGIN') return 'login'
				if (key === 'DANBOORU_API_KEY') return 'key'
				if (key === 'REDIS_URL') return 'redis://localhost:6379'
				if (key === 'RATE_LIMIT_PER_MINUTE') return '60'
				return null
			}),
		} as unknown as jest.Mocked<ConfigService>

		mockRedisInstance = {
			xgroup: jest.fn().mockResolvedValue('OK'),
			xadd: jest.fn().mockResolvedValue('response-id'),
			xdel: jest.fn().mockResolvedValue(1),
			xreadgroup: jest.fn().mockResolvedValue(null),
			xack: jest.fn().mockResolvedValue(1),
			get: jest.fn().mockResolvedValue(null),
			setex: jest.fn().mockResolvedValue('OK'),
			incr: jest.fn().mockResolvedValue(1),
			expire: jest.fn().mockResolvedValue(1),
			ping: jest.fn().mockResolvedValue('PONG'),
			disconnect: jest.fn().mockResolvedValue(undefined),
		} as any

		mockRedisConstructor.mockImplementation(() => mockRedisInstance)
		;(plainToClass as jest.Mock).mockImplementation((dto: any, obj: any) => ({
			...obj,
		}))

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				DanbooruService,
				{ provide: ConfigService, useValue: mockConfigService },
				{ provide: 'REDIS_CLIENT', useValue: mockRedisInstance },
			],
		}).compile()

		service = module.get<DanbooruService>(DanbooruService)
	})

	afterEach(() => {
		jest.clearAllMocks()
	})

	describe('processRequest', () => {
		const jobId = 'test1'
		const query = 'hatsune_miku 1girl'

		it('should process request and return DanbooruResponse on success', async () => {
			const mockPost = {
				file_url: 'https://example.com/image.jpg',
				tag_string_artist: 'artist',
				tag_string_general: 'tags',
				rating: 's',
				source: 'https://source.com',
				tag_string_copyright: 'copyright',
			} as any

			mockAxios.get.mockResolvedValue({ data: [mockPost] })
			mockRedisInstance.get.mockResolvedValue(null)
			mockRedisInstance.incr.mockResolvedValue(1)

			const result = await service.processRequest(jobId, query)

			expect(mockAxios.get).toHaveBeenCalledWith(
				expect.stringContaining('danbooru.donmai.us/posts.json'),
				expect.objectContaining({
					auth: { username: 'login', password: 'key' },
					timeout: API_TIMEOUT_MS,
				}),
			)
			expect(result).toEqual<DanbooruResponse>({
				type: 'success',
				jobId,
				imageUrl: 'https://example.com/image.jpg',
				author: 'artist',
				tags: 'tags',
				rating: 's',
				source: 'https://source.com',
				copyright: 'copyright',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				RESPONSES_STREAM,
				'*',
				'type',
				'success',
				'jobId',
				jobId,
				'imageUrl',
				mockPost.file_url,
				'author',
				mockPost.tag_string_artist,
				'tags',
				mockPost.tag_string_general,
				'rating',
				mockPost.rating,
				'source',
				mockPost.source,
				'copyright',
				mockPost.tag_string_copyright,
			)
			expect(mockRedisInstance.incr).toHaveBeenCalledWith(
				expect.stringContaining('rate:minute:'),
			)
			expect(mockRedisInstance.expire).toHaveBeenCalledWith(
				expect.stringContaining('rate:minute:'),
				60,
			)
			expect(mockRedisInstance.setex).toHaveBeenCalledWith(
				expect.stringContaining('cache:danbooru:'),
				3600,
				expect.stringContaining(JSON.stringify(result)),
			)
		})

		it('should return cached response on cache hit', async () => {
			const cachedResponse: DanbooruResponse = {
				type: 'success',
				jobId,
				imageUrl: 'https://cached.com/image.jpg',
				author: 'cached_artist',
				tags: 'cached_tags',
				rating: 's',
				source: null,
				copyright: 'cached_copyright',
			}

			mockRedisInstance.get.mockResolvedValue(JSON.stringify(cachedResponse))
			mockAxios.get.mockResolvedValue({ data: [] }) // Should not be called

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual(cachedResponse)
			expect(mockAxios.get).not.toHaveBeenCalled()
			expect(mockRedisInstance.get).toHaveBeenCalledWith(
				expect.stringContaining('cache:danbooru:'),
			)
		})

		it('should handle rate limit exceeded', async () => {
			mockRedisInstance.incr.mockResolvedValue(RATE_LIMIT_PER_MINUTE + 1)
			mockRedisInstance.get.mockResolvedValue(null)

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual<DanbooruErrorResponse>({
				type: 'error',
				jobId,
				error: 'Rate limit exceeded. Try again in 1 minute.',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				RESPONSES_STREAM,
				'*',
				'type',
				'error',
				'jobId',
				jobId,
				'error',
				'Rate limit exceeded. Try again in 1 minute.',
			)
		})

		it('should return DanbooruErrorResponse on API error', async () => {
			const mockError = new Error('Request failed with status code 401')
			mockAxios.get.mockRejectedValue(mockError)
			mockRedisInstance.get.mockResolvedValue(null)
			mockRedisInstance.incr.mockResolvedValue(1)

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual<DanbooruErrorResponse>({
				type: 'error',
				jobId,
				error: 'Request failed with status code 401',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				DLQ_STREAM,
				'*',
				'jobId',
				jobId,
				'error',
				'Request failed with status code 401',
				'query',
				query,
			)
		})

		it('should return error if no posts found', async () => {
			mockAxios.get.mockResolvedValue({ data: [] })
			mockRedisInstance.get.mockResolvedValue(null)
			mockRedisInstance.incr.mockResolvedValue(1)

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual<DanbooruErrorResponse>({
				type: 'error',
				jobId,
				error: 'No posts found for the query',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				DLQ_STREAM,
				'*',
				'jobId',
				jobId,
				'error',
				'No posts found for the query',
				'query',
				query,
			)
		})

		it('should sanitize tags in response', async () => {
			const mockPost = {
				file_url: 'https://example.com/image.jpg',
				tag_string_artist: 'artist',
				tag_string_general: '<script>alert("xss")</script> tag1, tag2',
				rating: 's',
				source: 'https://source.com',
				tag_string_copyright: 'copy <b>bold</b> right',
			} as any

			mockAxios.get.mockResolvedValue({ data: [mockPost] })
			mockRedisInstance.get.mockResolvedValue(null)
			mockRedisInstance.incr.mockResolvedValue(1)

			const result = await service.processRequest('test-sanitize', 'test query')

			expect(result).toEqual<DanbooruResponse>({
				type: 'success',
				jobId: 'test-sanitize',
				imageUrl: 'https://example.com/image.jpg',
				author: 'artist',
				tags: ' tag1, tag2',
				rating: 's',
				source: 'https://source.com',
				copyright: 'copy bold right',
			})
		})
	})

	describe('validation in consumer', () => {
		it('should publish error on invalid DTO', async () => {
			const validationError = {
				property: 'jobId',
				constraints: { isNotEmpty: 'jobId should not be empty' },
			} as any
			;(classValidator.validate as jest.Mock).mockResolvedValue([
				validationError,
			])

			const mockFields = ['query', 'hatsune_miku']
			const mockMessage = ['id', mockFields] as any
			const mockStream = [['danbooru:requests', [mockMessage]]] as any

			let callCount = 0
			mockRedisInstance.xreadgroup.mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					return mockStream
				} else {
					;(service as any).running = false
					return null
				}
			})

			await (service as any).startConsumer()

			expect(classValidator.validate).toHaveBeenCalled()
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				RESPONSES_STREAM,
				'*',
				'type',
				'error',
				'jobId',
				'unknown',
				'error',
				'Invalid request format',
			)
			expect(mockRedisInstance.xack).toHaveBeenCalledWith(
				REQUESTS_STREAM,
				'danbooru-group',
				'id',
			)
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				DLQ_STREAM,
				'*',
				'jobId',
				'unknown',
				'error',
				'Invalid request format',
				'query',
				'hatsune_miku',
			)
		})

		it('should handle invalid query with SQL-like injection', async () => {
			const validationError = {
				property: 'query',
				constraints: {
					matches:
						'Query can only contain letters, numbers, underscores, spaces, hyphens, commas, colons, and parentheses (Danbooru-safe tags)',
				},
			} as any
			;(classValidator.validate as jest.Mock).mockResolvedValue([
				validationError,
			])

			const mockFields = ['jobId', 'test1', 'query', "'; DROP TABLE users; --"]
			const mockMessage = ['id', mockFields] as any
			const mockStream = [['danbooru:requests', [mockMessage]]] as any

			let callCount = 0
			mockRedisInstance.xreadgroup.mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					return mockStream
				} else {
					;(service as any).running = false
					return null
				}
			})

			await (service as any).startConsumer()

			expect(classValidator.validate).toHaveBeenCalled()
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				RESPONSES_STREAM,
				'*',
				'type',
				'error',
				'jobId',
				'test1',
				'error',
				'Invalid request format',
			)
			expect(mockRedisInstance.xack).toHaveBeenCalledWith(
				REQUESTS_STREAM,
				'danbooru-group',
				'id',
			)
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				DLQ_STREAM,
				'*',
				'jobId',
				'test1',
				'error',
				'Invalid request format',
				'query',
				"'; DROP TABLE users; --",
			)
		})

		it('should handle multiple messages in stream', async () => {
			const mockPost = {
				file_url: 'https://example.com/image.jpg',
				tag_string_artist: 'artist',
				tag_string_general: 'tags',
				rating: 's',
				source: 'https://source.com',
				tag_string_copyright: 'copyright',
			} as any

			mockAxios.get.mockResolvedValue({ data: [mockPost] })

			const mockFields1 = ['jobId', 'test1', 'query', 'hatsune_miku 1girl']
			const mockFields2 = ['jobId', 'test2', 'query', 'cat_ears']
			const mockMessage1 = ['id1', mockFields1] as any
			const mockMessage2 = ['id2', mockFields2] as any
			const mockStream = [
				['danbooru:requests', [mockMessage1, mockMessage2]],
			] as any

			;(classValidator.validate as jest.Mock).mockResolvedValue([])

			let callCount = 0
			mockRedisInstance.xreadgroup.mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					return mockStream
				} else {
					;(service as any).running = false
					return null
				}
			})

			await (service as any).startConsumer()

			expect(mockRedisInstance.xack).toHaveBeenCalledTimes(2)
			expect(mockRedisInstance.xadd).toHaveBeenCalledTimes(2) // 2 responses from processRequest
		})

		it('should handle Redis disconnect gracefully', async () => {
			const setTimeoutSpy = jest
				.spyOn(global, 'setTimeout')
				.mockImplementation((cb: () => void, delay?: number) => {
					process.nextTick(cb)
					return 1 as any
				})

			const mockPost = {
				file_url: 'https://example.com/image.jpg',
				tag_string_artist: 'artist',
				tag_string_general: 'tags',
				rating: 's',
				source: 'https://source.com',
				tag_string_copyright: 'copyright',
			} as any

			mockAxios.get.mockResolvedValue({ data: [mockPost] })

			const mockError = new Error('Connection lost')
			const mockFields = ['jobId', 'test1', 'query', 'hatsune_miku']
			const mockMessage = ['id', mockFields] as any
			const mockStream = [['danbooru:requests', [mockMessage]]] as any

			;(classValidator.validate as jest.Mock).mockResolvedValue([])

			let attemptCount = 0
			let callCount = 0
			mockRedisInstance.xreadgroup.mockImplementation(async () => {
				callCount++
				attemptCount++
				if (attemptCount <= 5) {
					throw mockError
				} else if (callCount === 6) {
					// Succeed after retries
					return mockStream
				} else {
					;(service as any).running = false
					return null
				}
			})

			await (service as any).startConsumer()

			expect(mockRedisInstance.xreadgroup).toHaveBeenCalledTimes(7) // 5 failures + success + final null call
			expect(mockRedisInstance.xack).toHaveBeenCalledWith(
				REQUESTS_STREAM,
				'danbooru-group',
				'id',
			)

			setTimeoutSpy.mockRestore()
		}, 20000)
	})

	describe('cache operations', () => {
		const jobId = 'test-cache'

		it('should use encodeURIComponent for cache key', async () => {
			const queryWithSpecialChars = 'cat_ears+rating:s' // + encoded to %2B
			const mockPost = {
				file_url: 'https://example.com/image.jpg',
				tag_string_artist: 'artist',
				tag_string_general: 'tags',
				rating: 's',
				source: 'https://source.com',
				tag_string_copyright: 'copyright',
			} as any

			mockAxios.get.mockResolvedValue({ data: [mockPost] })
			mockRedisInstance.get.mockResolvedValue(null)
			mockRedisInstance.incr.mockResolvedValue(1)

			await service.processRequest(jobId, queryWithSpecialChars)

			expect(mockRedisInstance.get).toHaveBeenCalledWith(
				expect.stringContaining('cache:danbooru:cat_ears%2Brating%3As'),
			)
			expect(mockRedisInstance.setex).toHaveBeenCalledWith(
				expect.stringContaining('cache:danbooru:cat_ears%2Brating%3As'),
				3600,
				expect.any(String),
			)
		})
	})
})
