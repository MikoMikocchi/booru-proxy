import {
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  Min,
  MaxLength,
  Matches,
} from 'class-validator'

export class DanbooruPost {
  @IsNumber()
  id: number

  @IsString()
  file_url: string

  @IsOptional()
  @IsString()
  large_file_url?: string

  @IsOptional()
  @IsString()
  tag_string_artist?: string

  @IsString()
  @MaxLength(1000)
  @Matches(/^[a-z0-9\s_,:()-]+$/, { message: 'Invalid tag characters' })
  tag_string_general: string

  @IsOptional()
  @IsString()
  tag_string_character?: string

  @IsString()
  tag_string_copyright: string

  @IsEnum(['g', 's', 'q', 'e'])
  rating: 'g' | 's' | 'q' | 'e'

  @IsOptional()
  @IsString()
  source?: string

  @IsNumber()
  @Min(0)
  score: number

  @IsDateString()
  created_at: string
}
