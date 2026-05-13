import { IsString, Matches } from 'class-validator';
export class AddChannelDto {
  @IsString() @Matches(/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/)
  username!: string;
}
