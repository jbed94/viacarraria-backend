import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadSourceDto {
  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MaxLength(100)
  nodeId!: string;
}

export class PartDto {
  @IsInt()
  @Min(1)
  partNumber!: number;

  @IsString()
  eTag!: string;
}

export class PresignedUploadDto {
  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MaxLength(100)
  nodeId!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  fileSize!: number;

  @IsString()
  fileType!: string;

  @IsOptional()
  @IsString()
  checksumSha256?: string;

  @IsOptional()
  @IsBoolean()
  isMultipart?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  partCount?: number;
}

export class CompleteUploadDto {
  @IsString()
  sourceId!: string;

  @IsString()
  jobId!: string;

  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MaxLength(100)
  nodeId!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  fileSize!: number;

  @IsString()
  fileType!: string;

  @IsString()
  storageKey!: string;

  @IsOptional()
  @IsString()
  checksumSha256?: string;

  @IsOptional()
  @IsString()
  uploadId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartDto)
  parts?: PartDto[];
}

export class AbortUploadDto {
  @IsString()
  storageKey!: string;

  @IsOptional()
  @IsString()
  uploadId?: string;
}

export class UpdateSourceStatusDto {
  @IsIn(['PENDING', 'PROCESSING', 'READY', 'ERROR'])
  status!: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR';

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;
}

export type UploadedDocument = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};
