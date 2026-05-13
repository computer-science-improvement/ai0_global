import { IsInt, IsOptional, IsString, IsUrl } from 'class-validator';

export class TelegramLoginDto {
  @IsInt()                id!: number;
  @IsString()             first_name!: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsUrl()    photo_url?: string;
  @IsInt()                auth_date!: number;
  @IsString()             hash!: string;
}
