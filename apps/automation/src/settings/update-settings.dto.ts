import { IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Partial update for the editable Telegram "Відстеження" settings. Every
 *  field is optional; only provided keys are persisted. Ranges are sanity
 *  bounds, not Telegram limits. */
export class UpdateSettingsDto {
  @IsOptional() @IsBoolean()
  trackingEnabled?: boolean;

  // Owner chat id for admin notifications. A numeric string, or '' to clear the
  // DB override (falls back to the env TELEGRAM_OWNER_ID, then disabled).
  @IsOptional() @Matches(/^(\d+)?$/, { message: 'telegramOwnerId must be a numeric chat id (or empty)' })
  telegramOwnerId?: string;

  @IsOptional() @IsBoolean()
  trackingShareSession?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(365)
  statsPostAgeDays?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1440)
  postingCooldownMin?: number;

  @IsOptional() @IsInt() @Min(1000) @Max(120000)
  fetchTimeoutMs?: number;
}
