import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateActionDto {
  @IsIn(['reply', 'schedule_post']) type!: 'reply' | 'schedule_post';
  @IsOptional() @IsString() threadId?: string;
  @IsObject() payload!: Record<string, any>;
}
