import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { AD_FORMATS, AdFormat } from '../ad-orders.types';

export class UpsertPriceDto {
  /** tracked_channels.channel_key, e.g. '@my_channel'. */
  @IsString() @Matches(/^@?[A-Za-z0-9_]{3,64}$/, { message: 'channelKey must look like @channel_name' }) channelKey!: string;
  @IsIn(AD_FORMATS as unknown as string[]) format!: AdFormat;
  @IsInt() @Min(1) priceUah!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
