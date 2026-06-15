// apps/automation/src/config/api/dto/landing.dto.ts
import { IsBoolean, IsInt, Min } from 'class-validator';

export class PatchLandingDto {
  @IsBoolean()
  landingVisible!: boolean;

  @IsInt()
  @Min(0)
  landingOrder!: number;
}
