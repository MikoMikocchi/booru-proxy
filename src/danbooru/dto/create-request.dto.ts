import { IsString, IsNotEmpty } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  jobId: string;

  @IsString()
  @IsNotEmpty()
  query: string;
}
