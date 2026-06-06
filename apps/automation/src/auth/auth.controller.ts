import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TelegramLoginDto } from './telegram-login.dto';
import { TokenLoginDto } from './token-login.dto';
import { ConfigService } from '@nestjs/config';

const COOKIE_NAME = 'tracking_jwt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth:   AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('telegram-login')
  async login(@Body() dto: TelegramLoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, payload } = await this.auth.loginWithTelegram(dto);
    this.setSessionCookie(res, token);
    return { tgUserId: payload.sub, firstName: payload.firstName, username: payload.username };
  }

  /** Shared-token login — paste the TRACKING_TOKEN secret to get a session
   *  cookie. For HTTP/no-DNS boxes where the Telegram widget can't run. */
  @Post('token-login')
  async tokenLogin(@Body() dto: TokenLoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, payload } = await this.auth.loginWithToken(dto.token);
    this.setSessionCookie(res, token);
    return { tgUserId: payload.sub, firstName: payload.firstName, username: payload.username };
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge:   30 * 86_400 * 1000,
    });
  }

  @Get('me')
  async me(@Req() req: Request) {
    const token = (req as any).cookies?.[COOKIE_NAME];
    if (!token) return null;
    const payload = await this.auth.verifyToken(token);
    if (!payload) return null;
    return { tgUserId: payload.sub, firstName: payload.firstName, username: payload.username };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    // clearCookie only deletes when the attributes match the Set-Cookie that
    // created it — otherwise the browser keeps the session cookie and the
    // user stays logged in. Mirror setSessionCookie's options.
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure:   this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path:     '/',
    });
    return { ok: true };
  }
}
