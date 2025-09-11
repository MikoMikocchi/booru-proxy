import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator'

export class CreateRequestDto {
	@IsNotEmpty()
	@IsString()
	jobId: string

	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	@Matches(/^[a-z0-9_ \-:]+$/i, {
		message:
			'Query can only contain lowercase letters, numbers, underscores, spaces, hyphens, plus signs, and colons',
	})
	query: string
}
