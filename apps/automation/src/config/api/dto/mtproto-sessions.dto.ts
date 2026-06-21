// apps/automation/src/config/api/dto/mtproto-sessions.dto.ts
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateMtprotoSessionDto {
  @IsString()
  @MaxLength(80)
  label!: string;

  // Plaintext MTProto session string — encrypted on save into session_enc,
  // never echoed back, never logged. StringSessions can be long.
  @IsString()
  @MaxLength(8192)
  session!: string;

  // Per-session Telegram app credentials (from my.telegram.org). Both optional:
  // omit them to fall back to the env TELEGRAM_API_ID / TELEGRAM_API_HASH.
  // apiId is a numeric string (not secret); apiHash is encrypted on save into
  // api_hash_enc — never echoed back, never logged.
  @IsOptional()
  @Matches(/^\d+$/, { message: 'apiId must be a numeric string' })
  @MaxLength(32)
  apiId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  apiHash?: string;

  @IsOptional()
  @IsIn(['tracker', 'agent'])
  role?: 'tracker' | 'agent';
}

export class PatchMtprotoSessionDto {
  @IsBoolean()
  active!: boolean;
}
