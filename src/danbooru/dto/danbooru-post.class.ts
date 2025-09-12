import {
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
  IsUrl,
  Min,
  MaxLength,
  Matches,
} from 'class-validator'

import { Type, Transform } from 'class-transformer'

export class DanbooruPost {
  @IsNumber()
  id: number

  @IsString()
  @IsUrl({}, { message: 'file_url must be a valid URL' })
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
  @Transform(({ value }) => value?.toLowerCase().trim())
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
  @IsUrl({}, { message: 'source must be a valid URL' })
  source?: string

  @IsNumber()
  @Min(0)
  score: number

  @IsDateString()
  @Type(() => Date)
  created_at: Date
}
