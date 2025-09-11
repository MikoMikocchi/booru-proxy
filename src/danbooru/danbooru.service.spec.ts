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
				return null
			}),
		} as unknown as jest.Mocked<ConfigService>

		mockRedisInstance = {
			xadd: jest.fn().mockResolvedValue('response-id'),
			xdel: jest.fn().mockResolvedValue(1),
			xread: jest.fn().mockResolvedValue(null),
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
			],
		}).compile()

		service = module.get<DanbooruService>(DanbooruService)
		;(service as any).redis = mockRedisInstance
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

			const result = await service.processRequest(jobId, query)

			expect(mockAxios.get).toHaveBeenCalledWith(
				expect.stringContaining('danbooru.donmai.us/posts.json'),
				expect.objectContaining({
					auth: { username: 'login', password: 'key' },
					timeout: 10000,
				}),
			)
			expect(result).toEqual<DanbooruResponse>({
				jobId,
				imageUrl: 'https://example.com/image.jpg',
				author: 'artist',
				tags: 'tags',
				rating: 's',
				source: 'https://source.com',
				copyright: 'copyright',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalledWith(
				'danbooru:responses',
				'*',
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
		})

		it('should return DanbooruErrorResponse on API error', async () => {
			const mockError = new Error('Request failed with status code 401')
			mockAxios.get.mockRejectedValue(mockError)

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual<DanbooruErrorResponse>({
				jobId,
				error: 'Request failed with status code 401',
			})
			expect(mockRedisInstance.xadd).toHaveBeenCalled()
		})

		it('should return error if no posts found', async () => {
			mockAxios.get.mockResolvedValue({ data: [] })

			const result = await service.processRequest(jobId, query)

			expect(result).toEqual<DanbooruErrorResponse>({
				jobId,
				error: 'No posts found for the query',
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
			mockRedisInstance.xread.mockImplementation(async () => {
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
				'danbooru:responses',
				'*',
				'jobId',
				'unknown',
				'error',
				'Invalid request format',
			)
			expect(mockRedisInstance.xdel).toHaveBeenCalledWith(
				'danbooru:requests',
				'id',
			)
		})
	})
})
