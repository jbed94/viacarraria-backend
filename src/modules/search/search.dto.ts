import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SearchDto {
  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  query!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedNodeIds?: string[];

  @IsOptional()
  @IsBoolean()
  extendedSearch?: boolean;
}

export class UpdateQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
