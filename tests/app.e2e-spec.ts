import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruService } from '../src/danbooru/danbooru.service'
import Redis from 'ioredis'

describe('DanbooruService (integration)', () => {
	let service: DanbooruService
	let mockRedis: jest.Mocked<Redis>

	beforeEach(async () => {
		mockRedis = {
			xadd: jest.fn().mockResolvedValue('1-0'),
			xreadgroup: jest.fn().mockResolvedValue(null),
			xack: jest.fn().mockResolvedValue(1),
			get: jest.fn().mockResolvedValue(null),
			setex: jest.fn().mockResolvedValue('OK'),
			sadd: jest.fn().mockResolvedValue(1),
			expire: jest.fn().mockResolvedValue(1),
			sismember: jest.fn().mockResolvedValue(0),
			ping: jest.fn().mockResolvedValue('PONG'),
		} as any

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				DanbooruService,
				{ provide: 'REDIS_CLIENT', useValue: mockRedis },
			],
		}).compile()

		service = module.get<DanbooruService>(DanbooruService)
	})

	it('should process request and publish response', async () => {
		const jobId = 'test-job'
		const query = 'hatsune_miku'

		const result = await service.processRequest(jobId, query)

		expect(result.type).toBe('success')
		expect(mockRedis.xadd).toHaveBeenCalledWith(
			expect.any(String), // RESPONSES_STREAM
			'*',
			expect.anything(),
		)
	})

	afterEach(() => {
		jest.clearAllMocks()
	})
})
