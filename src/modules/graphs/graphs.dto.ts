import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateGraphDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateGraphDto {
  @IsArray()
  nodes!: unknown[];

  @IsArray()
  edges!: unknown[];
}

export class CopyGraphDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  title!: string;
}
