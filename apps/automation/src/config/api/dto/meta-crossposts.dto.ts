import { IsBoolean, IsIn, IsString } from 'class-validator';

const PLATFORMS = ['instagram', 'facebook', 'threads'] as const;
const MODES = ['mirror', 'teaser'] as const;

export class CreateCrosspostDto {
  @IsIn(PLATFORMS as unknown as string[])
  platform!: typeof PLATFORMS[number];

  @IsString()
  metaAccountId!: string;

  @IsIn(MODES as unknown as string[])
  mode!: typeof MODES[number];
}

export class PatchCrosspostDto {
  @IsBoolean()
  enabled!: boolean;
}
