import { IsBoolean, IsOptional } from 'class-validator';

/** Body for POST /auth/sessions/revoke-all. `includeCurrent` also ends the caller's own session. */
export class RevokeAllDto {
  @IsOptional() @IsBoolean() includeCurrent?: boolean;
}
