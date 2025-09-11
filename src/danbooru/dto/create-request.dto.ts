import { IsString, IsNotEmpty } from 'class-validator'

export class CreateRequestDto {
	@IsNotEmpty()
	@IsString()
	jobId: string

	@IsNotEmpty()
	@IsString()
	query: string
}
