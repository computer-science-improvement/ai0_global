import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TelegramLoginDto } from './telegram-login.dto';

const BOT_TOKEN = '123:bot-token';

function makeService(env: Record<string, string | undefined>) {
  const config = { get: (k: string) => env[k] } as any;
  const jwt = { signAsync: async () => 'signed.jwt', verifyAsync: async () => ({}) } as any;
  return new AuthService(config, jwt);
}

/** Build a Telegram login payload with a valid widget signature. */
function signedLogin(id: number): TelegramLoginDto {
  const fields: Omit<TelegramLoginDto, 'hash'> = {
    id, first_name: 'Owner', username: 'owner', auth_date: Math.floor(Date.now() / 1000),
  };
  const dataCheckString = Object.keys(fields).sort()
    .map((k) => `${k}=${(fields as any)[k]}`).join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

test('telegram login FAILS CLOSED when TRACKING_ALLOWED_TG_USER_IDS is empty', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '' });
  await assert.rejects(
    () => svc.loginWithTelegram(signedLogin(42)),
    (e: unknown) => e instanceof ForbiddenException && /Login disabled/.test((e as Error).message),
  );
});

test('telegram login FAILS CLOSED when TRACKING_ALLOWED_TG_USER_IDS is unset', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
  await assert.rejects(() => svc.loginWithTelegram(signedLogin(42)), ForbiddenException);
});

test('telegram login FAILS CLOSED when the allowlist has only junk entries', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: ' , abc,' });
  await assert.rejects(() => svc.loginWithTelegram(signedLogin(42)), ForbiddenException);
});

test('telegram login accepts an allowlisted user', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '7, 42' });
  const { token, payload } = await svc.loginWithTelegram(signedLogin(42));
  assert.equal(token, 'signed.jwt');
  assert.equal(payload.sub, 42);
});

test('telegram login rejects a user outside the allowlist', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '7' });
  await assert.rejects(() => svc.loginWithTelegram(signedLogin(42)), /User not in allowlist/);
});

test('telegram login rejects a tampered signature', async () => {
  const svc = makeService({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '42' });
  const dto = { ...signedLogin(42), hash: 'a'.repeat(64) };
  await assert.rejects(() => svc.loginWithTelegram(dto), UnauthorizedException);
});

test('token login: accepts the exact TRACKING_TOKEN, rejects anything else', async () => {
  const svc = makeService({ TRACKING_TOKEN: 'secret' });
  assert.equal((await svc.loginWithToken('secret')).token, 'signed.jwt');
  await assert.rejects(() => svc.loginWithToken('secreT'), /Invalid token/);
  await assert.rejects(() => svc.loginWithToken('secret-longer'), /Invalid token/);
});
