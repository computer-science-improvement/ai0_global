// apps/automation/src/config/api/dto/telegraph-accounts.dto.ts
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTelegraphAccountDto {
  @IsString()
  @Matches(/^[a-z0-9_-]+$/i, { message: 'account_id must be alphanumeric + - + _' })
  @MaxLength(64)
  account_id!: string;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'token_env must be UPPER_SNAKE_CASE' })
  @MaxLength(64)
  token_env!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  author_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  author_url?: string;
}

export class PatchTelegraphAccountDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
