import { IsISO8601, IsOptional, IsString } from 'class-validator';

/** Every field falls back to the order: channel_id, creative (or this legacy text), publish_at. */
export class ScheduleOrderDto {
  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsISO8601() scheduledAt?: string;
}
