import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import type { PlanLimits } from './plans.types.js';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  adsEnabled?: boolean;

  @IsOptional()
  limits?: Partial<PlanLimits>;
}

export class UpdateStorageLimitDto {
  @IsNumber()
  @Min(1)
  storageLimitMb!: number;
}

export class AdTelemetryDto {
  @IsString()
  eventType!:
    'impression' | 'culled' | 'viewable_pulse' | 'refresh' | 'consent';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;

  @IsOptional()
  @IsString()
  consent?: string;

  @IsOptional()
  @IsString()
  slotId?: string;

  @IsOptional()
  @IsString()
  graphId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class CreateAdContextTagDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAdContextTagDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
