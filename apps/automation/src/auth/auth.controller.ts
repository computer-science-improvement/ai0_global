import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TelegramLoginDto } from './telegram-login.dto';
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
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge:   30 * 86_400 * 1000,
    });
    return { tgUserId: payload.sub, firstName: payload.firstName, username: payload.username };
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
    res.clearCookie(COOKIE_NAME);
    return { ok: true };
  }
}
