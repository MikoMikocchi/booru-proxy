import { IsString, IsNotEmpty, Matches } from 'class-validator'

export class CreateRequestDto {
	@IsNotEmpty()
	@IsString()
	jobId: string

	@IsNotEmpty()
	@IsString()
	@Matches(/^[a-z0-9_ ]+$/, {
		message:
			'Query can only contain lowercase letters, numbers, underscores and spaces',
	})
	query: string
}
