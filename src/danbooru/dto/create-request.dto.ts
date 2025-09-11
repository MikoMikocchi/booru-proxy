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
  @Matches(/^[a-zA-Z0-9_][a-zA-Z0-9_ \-,:()]{0,99}$/i, {
    message:
      'Query can only contain letters, numbers, underscores, spaces, hyphens, commas, colons, and parentheses (Danbooru-safe tags), no negation (~) or other specials, starting with alphanumeric or underscore, max 100 chars',
  })
  query: string

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  apiKey: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9_]{1,50}$/, {
    message: 'clientId must be alphanumeric with underscores, max 50 chars',
  })
  clientId?: string
}
