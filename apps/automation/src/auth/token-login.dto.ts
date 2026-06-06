import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/token-login — a single shared operator token compared
 *  against the TRACKING_TOKEN env secret. */
export class TokenLoginDto {
  @IsString() @MinLength(1) @MaxLength(512) token!: string;
}
