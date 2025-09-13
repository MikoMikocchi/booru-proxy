import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { DanbooruPost } from './danbooru-post.class'

describe('DanbooruPost', () => {
  it('should validate a complete valid DanbooruPost', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      large_file_url: 'https://danbooru.donmai.us/data/__large_sample.jpg',
      tag_string_artist: 'artist_name',
      tag_string_general: '1girl solo blue_eyes',
      tag_string_character: 'character_name',
      tag_string_copyright: 'original',
      rating: 's',
      source: 'https://example.com/source',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBe(0)
    expect(post.tag_string_general).toBe('1girl solo blue_eyes')
    expect(post.created_at).toBeInstanceOf(Date)
  })

  it('should fail validation for invalid file_url', async () => {
    const postData = {
      id: 12345,
      file_url: 'invalid-url',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const urlErrors = errors.find(error => error.property === 'file_url')
    expect(urlErrors).toBeDefined()
    expect(urlErrors!.constraints!.isUrl).toBeDefined()
  })

  it('should fail validation for invalid source URL', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      source: 'invalid-source',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const sourceErrors = errors.find(error => error.property === 'source')
    expect(sourceErrors).toBeDefined()
    expect(sourceErrors!.constraints!.isUrl).toBeDefined()
  })

  it('should transform tag_string_general to lowercase and trim', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: '  Test Tags UPPERCASE  ',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBe(0)
    expect(post.tag_string_general).toBe('test tags uppercase')
  })

  it('should fail validation for invalid tag characters', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test!@#invalid',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const tagErrors = errors.find(
      error => error.property === 'tag_string_general',
    )
    expect(tagErrors).toBeDefined()
    expect(tagErrors!.constraints!.matches).toBeDefined()
  })

  it('should fail validation for tag_string_general exceeding max length', async () => {
    const longTag = 'a'.repeat(1001)
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: longTag,
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const lengthErrors = errors.find(
      error => error.property === 'tag_string_general',
    )
    expect(lengthErrors).toBeDefined()
    expect(lengthErrors!.constraints!.maxLength).toBeDefined()
  })

  it('should validate negative score', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: -10,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const scoreErrors = errors.find(error => error.property === 'score')
    expect(scoreErrors).toBeDefined()
    expect(scoreErrors!.constraints!.min).toBeDefined()
  })

  it('should validate invalid rating', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 'invalid' as any,
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const ratingErrors = errors.find(error => error.property === 'rating')
    expect(ratingErrors).toBeDefined()
    expect(ratingErrors!.constraints!.isEnum).toBeDefined()
  })

  it('should parse date string to Date object', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBe(0)
    expect(post.created_at).toBeInstanceOf(Date)
    expect(post.created_at.getTime()).toBe(
      new Date('2023-01-01T12:00:00Z').getTime(),
    )
  })

  it('should fail validation for invalid date string', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: 'invalid-date',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBeGreaterThan(0)
    const dateErrors = errors.find(error => error.property === 'created_at')
    expect(dateErrors).toBeDefined()
    expect(dateErrors!.constraints!.isDateString).toBeDefined()
  })

  it('should validate optional fields as undefined', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBe(0)
    expect(post.large_file_url).toBeUndefined()
    expect(post.tag_string_artist).toBeUndefined()
    expect(post.tag_string_character).toBeUndefined()
    expect(post.source).toBeUndefined()
  })

  it('should validate optional string fields with valid values', async () => {
    const postData = {
      id: 12345,
      file_url: 'https://danbooru.donmai.us/data/__sample.jpg',
      large_file_url: 'https://danbooru.donmai.us/data/__large.jpg',
      tag_string_artist: 'artist1',
      tag_string_character: 'character1',
      source: 'https://example.com',
      tag_string_general: 'test',
      tag_string_copyright: 'original',
      rating: 's',
      score: 100,
      created_at: '2023-01-01T12:00:00Z',
    }

    const post = plainToInstance(DanbooruPost, postData)
    const errors = await validate(post)

    expect(errors.length).toBe(0)
    expect(post.large_file_url).toBe(
      'https://danbooru.donmai.us/data/__large.jpg',
    )
    expect(post.tag_string_artist).toBe('artist1')
    expect(post.tag_string_character).toBe('character1')
    expect(post.source).toBe('https://example.com')
  })
})
