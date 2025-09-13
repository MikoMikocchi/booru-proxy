import { Test, TestingModule } from '@nestjs/testing'
import { DanbooruPost } from './danbooru-post.class'
import { validate } from 'class-validator'
import 'reflect-metadata'

describe('DanbooruPost', () => {
  let service: DanbooruPost

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DanbooruPost],
    }).compile()

    service = module.get<DanbooruPost>(DanbooruPost)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  describe('validation', () => {
    it('should validate a valid post', async () => {
      const validPost = new DanbooruPost()
      validPost.id = 1
      validPost.file_url = 'https://danbooru.donmai.us/data/original/1/1.jpg'
      validPost.tag_string_artist = 'artist_name'
      validPost.tag_string_general = 'general_tags'
      validPost.tag_string_character = 'character_tags'
      validPost.tag_string_copyright = 'copyright_tags'
      validPost.score = 100
      validPost.rating = 's'
      validPost.source = 'https://example.com/source'
      validPost.created_at = new Date('2023-01-01T00:00:00Z')

      const errors = await validate(validPost)
      expect(errors).toHaveLength(0)
    })
  })
})
