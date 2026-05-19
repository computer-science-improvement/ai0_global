// apps/automation/src/discovery/api/dto/recommendations.dto.ts
import { IsBoolean, IsInt, IsOptional, IsPositive, IsUUID, Max } from 'class-validator';

export class RecommendRequestDto {
  @IsUUID()
  targetChannelId!: string;

  @IsInt()
  @IsPositive()
  budget!: number;             // kopecks

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  excludeAlreadyTracked?: boolean;
}
