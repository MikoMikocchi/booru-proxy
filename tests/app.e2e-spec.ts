import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { ConfigService } from '@nestjs/config'
import { AppModule } from '../src/app.module'

describe('AppController (e2e)', () => {
	let app: INestApplication

	beforeEach(async () => {
	  const moduleFixture: TestingModule = await Test.createTestingModule({
	    imports: [AppModule],
	  }).compile()

	  app = moduleFixture.createNestApplication()
	  await app.init()
	  await app.startAllMicroservices()
	  const configService = moduleFixture.get(ConfigService)
	  const port = configService.get('PORT') || 3000
	  await app.listen(port)
	})

	it('/health (GET)', () => {
		return request(app.getHttpServer())
			.get('/health')
			.expect(200)
			.expect(res => {
				expect(res.body).toHaveProperty('info')
				expect(res.body.info).toHaveProperty('redis')
				expect(res.body.info.redis).toHaveProperty('status', 'up')
			})
	})

	afterEach(async () => {
		await app.close()
	})
})
