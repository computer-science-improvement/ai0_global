import { IsISO8601, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateOrderDto {
  @IsString() @MaxLength(200) advertiser!: string;
  @IsOptional() @IsString() channelId?: string;
  /** Ignored when priceId is given — the server computes the amount from the price. */
  @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a decimal string' }) amount?: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsUUID() priceId?: string;
  /** SponsoredCreative (PostSpec subset); validated by the service. */
  @IsOptional() @IsObject() creative?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(120) sponsorLabel?: string;
  @IsOptional() @IsISO8601() publishAt?: string;
  @IsOptional() @IsUUID() threadId?: string;
}

export class UpdateOrderDto {
  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsObject() creative?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(120) sponsorLabel?: string;
  @IsOptional() @IsISO8601() publishAt?: string;
  @IsOptional() @IsUUID() threadId?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
