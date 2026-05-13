import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac } from 'crypto';
import { TelegramLoginDto } from './telegram-login.dto';
import { JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt:    JwtService,
  ) {}

  async loginWithTelegram(input: TelegramLoginDto): Promise<{ token: string; payload: JwtPayload }> {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!botToken) throw new UnauthorizedException('Telegram bot not configured');

    const expectedHash = this.computeHash(input, botToken);
    if (expectedHash !== input.hash) throw new UnauthorizedException('Bad signature');

    const ageSec = Math.floor(Date.now() / 1000) - input.auth_date;
    if (ageSec > 86_400) throw new UnauthorizedException('Auth payload too old');

    const allow = (this.config.get<string>('TRACKING_ALLOWED_TG_USER_IDS') ?? '')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    if (allow.length > 0 && !allow.includes(input.id)) {
      throw new ForbiddenException('User not in allowlist');
    }

    const payload: JwtPayload = {
      sub: input.id, username: input.username, firstName: input.first_name,
    };
    const token = await this.jwt.signAsync(payload, { expiresIn: '30d' });
    return { token, payload };
  }

  private computeHash(input: TelegramLoginDto, botToken: string): string {
    const dataCheckString = (Object.keys(input) as (keyof TelegramLoginDto)[])
      .filter((k) => k !== 'hash' && input[k] !== undefined)
      .sort()
      .map((k) => `${k}=${input[k]}`)
      .join('\n');
    const secret = createHash('sha256').update(botToken).digest();
    return createHmac('sha256', secret).update(dataCheckString).digest('hex');
  }

  async verifyToken(token: string): Promise<JwtPayload | null> {
    try { return await this.jwt.verifyAsync<JwtPayload>(token); }
    catch { return null; }
  }
}
