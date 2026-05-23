// apps/automation/src/config/api/dto/my-bots.dto.ts
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateBotDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/i, { message: 'bot_id must be alphanumeric + underscore' })
  @MaxLength(64)
  bot_id!: string;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'token_env must be UPPER_SNAKE_CASE' })
  @MaxLength(64)
  token_env!: string;
}

export class PatchBotDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
