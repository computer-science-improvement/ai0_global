import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { AuthEventsRepository } from './auth-events.repository';
import { SessionService } from './session.service';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

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
  providers:   [AuthService, AuthSessionsRepository, AuthEventsRepository, SessionService, TrackingAuthGuard],
  exports:     [AuthService, SessionService],
})
export class AuthModule {}
