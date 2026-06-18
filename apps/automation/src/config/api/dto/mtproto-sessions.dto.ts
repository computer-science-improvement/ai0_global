// apps/automation/src/config/api/dto/mtproto-sessions.dto.ts
import { IsBoolean, IsString, MaxLength } from 'class-validator';

export class CreateMtprotoSessionDto {
  @IsString()
  @MaxLength(80)
  label!: string;

  // Plaintext MTProto session string — encrypted on save into session_enc,
  // never echoed back, never logged. StringSessions can be long.
  @IsString()
  @MaxLength(8192)
  session!: string;
}

export class PatchMtprotoSessionDto {
  @IsBoolean()
  active!: boolean;
}
