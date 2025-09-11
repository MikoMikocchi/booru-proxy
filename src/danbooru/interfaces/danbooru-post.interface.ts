export interface DanbooruPost {
	id: number
	file_url: string
	large_file_url?: string
	tag_string_artist?: string
	tag_string_general: string
	tag_string_character?: string
	tag_string_copyright: string
	rating: 'g' | 's' | 'q' | 'e'
	source?: string
	score: number
	created_at: string
}
