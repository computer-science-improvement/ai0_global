import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /auth/token-login — a single shared operator token compared
 *  against the TRACKING_TOKEN env secret. `via: 'link'` marks a sign-in from an
 *  authorization link (`/login?token=…`), audited as method `link`. */
export class TokenLoginDto {
  @IsString() @MinLength(1) @MaxLength(512) token!: string;
  @IsOptional() @IsIn(['form', 'link']) via?: 'form' | 'link';
}
