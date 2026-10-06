import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_ALERT, AuthAlert, AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { AuthEventsRepository } from './auth-events.repository';
import { SessionService } from './session.service';
import { LoginLimiter, LimiterRedis } from './login-limiter';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';

/**
 * Resolve the JWT signing secret. FAILS CLOSED in production: a missing
 * JWT_SECRET there is a fatal misconfiguration (otherwise anyone could forge a
 * session cookie against a well-known fallback). Outside production we allow a
 * clearly-marked insecure dev secret so local runs don't need setup.
 */
export function resolveJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (secret) return secret;
  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error('JWT_SECRET must be set in production — refusing to start with a fallback secret.');
  }
  return 'dev-insecure-jwt-secret-do-not-use-in-prod';
}

// The shared Redis client (TrackingModule) and TelegramNotifier (PublishersModule)
// come from @Global modules — importing those modules here would be a cycle, as
// both import AuthModule (directly or through the guard). Both are optional: a
// missing Redis means the in-memory limiter, a missing notifier means no alerts.
const limiterProvider = {
  provide: LoginLimiter,
  inject:  [{ token: REDIS_CLIENT, optional: true }],
  useFactory: (redis?: LimiterRedis) => {
    const logger = new Logger('LoginLimiter');
    if (!redis) logger.warn('Redis client not available; login limiter is in-memory only');
    return new LoginLimiter(redis ?? null, { warn: (m) => logger.warn(m) });
  },
};

const alertProvider = {
  provide: AUTH_ALERT,
  inject:  [{ token: TelegramNotifier, optional: true }],
  useFactory: (notifier?: TelegramNotifier): AuthAlert => {
    if (!notifier) new Logger('AuthModule').warn('TelegramNotifier not available; auth alerts are off');
    return (text) => (notifier ? notifier.notifyAlert(text) : Promise.resolve());
  },
};

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject:  [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config),
      }),
    }),
  ],
  controllers: [AuthController],
  // TrackingAuthGuard guards the /auth/sessions* and /auth/events routes.
  providers:   [
    AuthService, AuthSessionsRepository, AuthEventsRepository, SessionService, TrackingAuthGuard,
    limiterProvider, alertProvider,
  ],
  exports:     [AuthService, SessionService],
})
export class AuthModule {}
