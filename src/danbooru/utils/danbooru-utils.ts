import { DanbooruPost } from '../dto/danbooru-post.class'
import { DanbooruSuccessResponse } from '../interfaces/danbooru.interface'

/**
 * Extracts tags from Danbooru-style query string.
 * Supports basic tag extraction: "tag1 tag2 rating:safe" -> ['tag1', 'tag2'].
 * Filters out directives like rating:, limit: for cache key/invalidation.
 * @param query - Danbooru query string
 * @returns Sorted unique tags array
 */
export function extractTagsFromQuery(query: string): string[] {
  if (!query || typeof query !== 'string') {
    return []
  }

  const parts = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (part: string) =>
        !['rating:', 'limit:', 'order:', 'score:'].some(directive =>
          part.startsWith(directive),
        ),
    )

  return [...new Set(parts)].sort()
}

/**
 * Builds success response from Danbooru post.
 * Extracts required fields: imageUrl, author, tags, rating, source, copyright, id, characters.
 * @param post - DanbooruPost instance
 * @param jobId - Job ID for logging and response
 * @returns DanbooruSuccessResponse object
 */
export function buildSuccessResponse(
  post: DanbooruPost,
  jobId: string,
): DanbooruSuccessResponse {
  const imageUrl = post.file_url
  const author = post.tag_string_artist ?? null
  const tags = post.tag_string_general
  const rating = post.rating
  const source = post.source ?? null
  const copyright = post.tag_string_copyright
  const id = post.id
  const characters = post.tag_string_character ?? null

  return {
    type: 'success',
    jobId,
    imageUrl,
    author,
    tags,
    rating,
    source,
    copyright,
    id,
    characters,
  }
}
