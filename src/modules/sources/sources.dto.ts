import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UploadSourceDto {
  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MaxLength(100)
  nodeId!: string;
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
