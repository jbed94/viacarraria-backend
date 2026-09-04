import {
  IsArray,
  IsBoolean,
  IsIn,
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

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  sensitivity?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsIn(['narrow', 'normal', 'wide'])
  scope?: 'narrow' | 'normal' | 'wide';
}

export type SearchSensitivity = 'low' | 'medium' | 'high';
export type SearchScope = 'narrow' | 'normal' | 'wide';

export class UpdateQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
