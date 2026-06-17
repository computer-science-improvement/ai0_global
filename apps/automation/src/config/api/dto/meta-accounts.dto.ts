// apps/automation/src/config/api/dto/meta-accounts.dto.ts
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const PLATFORMS = ['instagram', 'facebook', 'threads'] as const;

export class CreateMetaAccountDto {
  @IsIn(PLATFORMS as unknown as string[])
  platform!: typeof PLATFORMS[number];

  @IsString()
  // Mirrors what Meta allows in page/IG handles: letters, digits, dot, underscore,
  // hyphen (e.g. "ai0.global.recipes"). No spaces or other specials.
  @Matches(/^[A-Za-z0-9._-]+$/, { message: 'accountId may contain letters, digits, . _ -' })
  @MaxLength(64)
  accountId!: string;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'tokenEnv must be UPPER_SNAKE_CASE' })
  @MaxLength(64)
  tokenEnv!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_.-]+$/, { message: 'targetId must be an object id' })
  @MaxLength(64)
  targetId!: string;
}

export class PatchMetaAccountDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
