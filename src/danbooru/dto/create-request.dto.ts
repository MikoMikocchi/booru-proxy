import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  IsOptional,
  IsUUID,
} from 'class-validator'

export class CreateRequestDto {
  @IsNotEmpty()
  @IsString()
  @IsUUID('all', { message: 'jobId must be a valid UUID' })
  jobId: string

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Matches(/^[\w\s\-,:()]{1,100}$/i, {
    message: 'Query: alphanumeric, spaces, hyphens, colons, parentheses only, max 100 chars',
  })
  query: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  apiKey?: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9_]{1,50}$/, {
    message: 'clientId must be alphanumeric with underscores, max 50 chars',
  })
  clientId?: string
}
