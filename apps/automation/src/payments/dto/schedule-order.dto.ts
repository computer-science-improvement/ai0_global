import { IsString } from 'class-validator';
export class ScheduleOrderDto {
  @IsString() channelId!: string;
  @IsString() text!: string;
  @IsString() scheduledAt!: string; // ISO
}
