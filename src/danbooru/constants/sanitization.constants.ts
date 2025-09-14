/**
 * Danbooru-specific string fields that require XSS sanitization.
 * Includes all user-generated or potentially malicious content fields.
 */
export const DANBOORU_STRING_FIELDS = [
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
