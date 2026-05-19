// apps/automation/src/discovery/api/dto/themes.dto.ts
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

export class UpdateThemesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]+$/, { each: true, message: 'theme slug must be lower-kebab-case' })
  themes!: string[];
}
