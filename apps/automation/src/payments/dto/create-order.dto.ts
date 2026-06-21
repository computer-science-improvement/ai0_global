import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
export class CreateOrderDto {
  @IsString() @MaxLength(200) advertiser!: string;
  @IsOptional() @IsString() channelId?: string;
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a decimal string' }) amount!: string;
  @IsString() @MaxLength(8) currency!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
