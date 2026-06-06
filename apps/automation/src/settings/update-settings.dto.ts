import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Partial update for the editable Telegram "Відстеження" settings. Every
 *  field is optional; only provided keys are persisted. Ranges are sanity
 *  bounds, not Telegram limits. */
export class UpdateSettingsDto {
  @IsOptional() @IsBoolean()
  trackingEnabled?: boolean;

  @IsOptional() @IsBoolean()
  trackingShareSession?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(365)
  statsPostAgeDays?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1440)
  postingCooldownMin?: number;

  @IsOptional() @IsInt() @Min(1000) @Max(120000)
  fetchTimeoutMs?: number;
}
