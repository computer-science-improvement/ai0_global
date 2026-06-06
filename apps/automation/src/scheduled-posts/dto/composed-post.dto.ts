import { IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ButtonDto { @IsString() @MaxLength(64) label!: string; @IsString() @MaxLength(2048) url!: string; }
class ButtonRowDto { @IsArray() @ValidateNested({ each: true }) @Type(() => ButtonDto) buttons!: ButtonDto[]; }

export class ComposedPostDto {
  @IsUUID() channelId!: string;
  @IsIn(['bot','mtproto_user']) sender!: 'bot' | 'mtproto_user';
  @IsOptional() @IsUUID() botId?: string | null;
  @IsString() @MaxLength(4096) text!: string;
  @IsIn(['none','photo','video']) mediaType!: 'none' | 'photo' | 'video';
  @IsOptional() @IsString() @MaxLength(2048) mediaUrl?: string | null;
  @IsIn(['above','below']) mediaPlacement!: 'above' | 'below';
  @IsArray() @ValidateNested({ each: true }) @Type(() => ButtonRowDto) buttons!: ButtonRowDto[];
  @IsISO8601() scheduledAt!: string;
}
