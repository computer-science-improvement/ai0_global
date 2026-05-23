// apps/automation/src/config/api/dto/strategies.dto.ts
import {
  IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString,
  IsUUID, Matches, MaxLength,
} from 'class-validator';

/**
 * Create input. `ext_id` is the logical name users see — alphanumeric +
 * `-`/`_` so it round-trips into config-file JSON if we ever export it back.
 * `channel_id` is the internal UUID (resolved via the channels picker on
 * the frontend, not the channelKey).
 */
export class CreateStrategyDto {
  @IsString()
  @Matches(/^[a-z0-9_-]+$/i, { message: 'ext_id must be alphanumeric + - + _' })
  @MaxLength(80)
  ext_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  type!: string;

  @IsUUID()
  channel_id!: string;

  // Cron expression — validated at controller-level against the `cron` lib
  // because class-validator's CronExpression validator is opinionated.
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  schedule!: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class PatchStrategyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64)
  type?: string;

  @IsOptional() @IsUUID()
  channel_id?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  schedule?: string;

  @IsOptional() @IsObject()
  params?: Record<string, unknown>;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string | null;
}
