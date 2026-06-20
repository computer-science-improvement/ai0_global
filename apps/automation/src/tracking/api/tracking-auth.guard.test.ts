import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingAuthGuard } from './tracking-auth.guard';

function makeCtx({ headers = {}, cookies = {} }: { headers?: Record<string, string>; cookies?: Record<string, string> }) {
  const req: any = { headers, cookies };
  return {
    ctx: { switchToHttp: () => ({ getRequest: () => req }) } as any,
    req,
  };
}

function makeGuard(env: Record<string, string | undefined>, verify: (t: string) => Promise<any> = async () => null) {
  const config = { get: (k: string) => env[k] } as any;
  const auth = { verifyToken: verify } as any;
  return new TrackingAuthGuard(config, auth);
}

test('accepts a matching bearer TRACKING_TOKEN', async () => {
  const guard = makeGuard({ TRACKING_TOKEN: 'secret' });
  const { ctx } = makeCtx({ headers: { authorization: 'Bearer secret' } });
  assert.equal(await guard.canActivate(ctx), true);
});

test('accepts a valid JWT cookie and attaches req.user', async () => {
  const guard = makeGuard({ TRACKING_TOKEN: 'secret' }, async () => ({ sub: 'u1' }));
  const { ctx, req } = makeCtx({ cookies: { tracking_jwt: 'jwt' } });
  assert.equal(await guard.canActivate(ctx), true);
  assert.deepEqual(req.user, { sub: 'u1' });
});

test('FAILS CLOSED: no credentials and no ALLOW_NO_AUTH → rejects', async () => {
  const guard = makeGuard({}); // TRACKING_TOKEN unset, no flag
  const { ctx } = makeCtx({});
  await assert.rejects(() => guard.canActivate(ctx), /Invalid or missing credentials/);
});

test('explicit ALLOW_NO_AUTH=true bypass works in dev when no creds presented', async () => {
  const guard = makeGuard({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' });
  const { ctx } = makeCtx({});
  assert.equal(await guard.canActivate(ctx), true);
});

test('ALLOW_NO_AUTH is ignored in production', async () => {
  const guard = makeGuard({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'production' });
  const { ctx } = makeCtx({});
  await assert.rejects(() => guard.canActivate(ctx), /Invalid or missing credentials/);
});

test('ALLOW_NO_AUTH does not bypass an invalid bearer token', async () => {
  const guard = makeGuard({ TRACKING_TOKEN: 'secret', ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' });
  const { ctx } = makeCtx({ headers: { authorization: 'Bearer wrong' } });
  await assert.rejects(() => guard.canActivate(ctx), /Invalid or missing credentials/);
});
