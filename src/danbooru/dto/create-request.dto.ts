import { IsString, IsNotEmpty, Matches, MaxLength, Length } from 'class-validator'

export class CreateRequestDto {
	@IsNotEmpty()
	@IsString()
	@Length(1, 36, { message: 'jobId must be between 1 and 36 characters' })
	jobId: string

	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	@Matches(/^[a-zA-Z0-9_][a-zA-Z0-9_ \-,:()]{0,199}$/i, {
		message:
			'Query can only contain letters, numbers, underscores, spaces, hyphens, commas, colons, and parentheses (Danbooru-safe tags), starting with alphanumeric or underscore',
	})
	query: string
}
