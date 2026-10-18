import { dailyRef, type InboxItemInput } from '../editor/agents/owner-inbox';
import type { MetaAccountRow } from './meta-accounts.repository';
import type { MyBotRow } from './my-bots.repository';
import type { TelegraphAccountRow } from './telegraph-accounts.repository';
import type { TikTokAccountRow } from './tiktok-accounts.repository';
import type { MtprotoSessionRow } from './mtproto-sessions.repository';

const DAY = 86_400_000;

/** Spec 049 FR-001: a Threads long-lived token (~60 days) is refreshed this many days before it expires. */
export const THREADS_REFRESH_DAYS = 10;

type TokenMeta = { type: string | null; expiresAt: Date | null; dataAccessExpiresAt: Date | null; scopes: string[]; isValid: boolean };

export interface KeeperDeps {
  meta: {
    list(): Promise<MetaAccountRow[]>;
    setTokenEnc(id: string, enc: string): Promise<void>;
    setTokenMeta(id: string, info: TokenMeta): Promise<void>;
    markVerifyError(id: string, error: string): Promise<void>;
  };
  graph: {
    refreshThreadsToken(token: string): Promise<{ accessToken: string; expiresInSec: number }>;
    inspectToken(token: string): Promise<TokenMeta | null>;
  };
  bots: {
    list(): Promise<MyBotRow[]>;
    markVerified(id: string, meta: { username: string; first_name: string }): Promise<void>;
    markVerifyError(id: string, error: string): Promise<void>;
  };
  getMe(token: string): Promise<{ username: string; first_name: string }>;
  telegraph: {
    list(): Promise<TelegraphAccountRow[]>;
    markVerified(id: string, meta: { short_name: string; author_name: string | null; author_url: string | null }): Promise<void>;
    markVerifyError(id: string, error: string): Promise<void>;
  };
  telegraphInfo(token: string): Promise<{ short_name: string; author_name?: string | null; author_url?: string | null }>;
  tiktok?: { list(): Promise<TikTokAccountRow[]>; getValidAccessToken(id: string): Promise<string> };
  mtproto: { list(): Promise<MtprotoSessionRow[]> };
  /** Plaintext token of a row (token_enc wins over the legacy env var); null when neither is set. */
  token(row: { token_enc: string | null; token_env: string | null }): string | null;
  /** Encrypts a refreshed token; throws when TOKEN_ENCRYPTION_KEY is not set. */
  encrypt(plain: string): string;
  inbox: { postOnce(i: InboxItemInput & { refType: string; refId: string }): Promise<number | null> };
  /** Config-change events (bots and Telegraph caches reload after a state flip). */
  changed?: (kind: 'bot' | 'telegraph', id: string) => Promise<void>;
  day(at: Date): string;
  /** A failed check is retried once after this many ms before the connection is marked broken. */
  retryMs?: number;
  log?: (m: string) => void;
}

export interface KeeperResult {
  threadsRefreshed: number;
  threadsFailed:    number;
  threadsExpired:   number;
  metaInspected:    number;
  botsBroken:       number;
  telegraphBroken:  number;
  tiktokFailed:     number;
  alerts:           number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Spec 049 FR-001: the daily connection upkeep. It keeps tokens alive where the platform allows it (Threads,
 * TikTok), reads Meta token expiry and validity so the resource health check sees them (`token_expiring` /
 * `token_invalid`), and re-checks every bot and Telegraph account. Connections that are not resources of the
 * catalog (bots, Telegraph accounts, MTProto sessions) get a once-a-day Inbox note while broken; resources are
 * alerted by the health check (FR-002) that runs after this.
 *
 * MTProto sessions are not reconnected here: the tracker and the agent client hold the same session open, and a
 * second connection with that auth key risks AUTH_KEY_DUPLICATED (Telegram then kills the session). Their stored
 * verify state is reported instead.
 */
export async function runConnectionKeeper(d: KeeperDeps, now: Date): Promise<KeeperResult> {
  const r: KeeperResult = { threadsRefreshed: 0, threadsFailed: 0, threadsExpired: 0, metaInspected: 0, botsBroken: 0, telegraphBroken: 0, tiktokFailed: 0, alerts: 0 };
  const day = d.day(now);
  const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch { await sleep(d.retryMs ?? 5_000); return fn(); }
  };
  const note = async (ref: string, title: string, body: string, alert: { title: string; body: string }) => {
    const id = await d.inbox.postOnce({ kind: 'connection_broken', severity: 'critical', title, body, alert, ...dailyRef(ref, day) });
    if (id != null) r.alerts++;
  };

  // Meta: Threads refresh, debug_token for Facebook / Instagram.
  let canStore = true;
  try { d.encrypt('probe'); } catch { canStore = false; }
  for (const a of (await d.meta.list()).filter((x) => x.active)) {
    const token = d.token(a);
    if (!token) continue; // the hourly Meta collector records the missing token
    try {
      if (a.platform === 'threads') {
        const exp = a.token_expires_at ? new Date(a.token_expires_at) : null;
        if (exp && exp.getTime() <= now.getTime()) {
          // Threads cannot refresh an expired token: only a reconnect helps. Stated so the health check says why.
          if (!a.verify_error?.startsWith('Threads token expired')) {
            await d.meta.markVerifyError(a.id, `Threads token expired on ${isoDay(exp)} — reconnect the account in /app/connections`);
          }
          r.threadsExpired++;
          continue;
        }
        if (exp && exp.getTime() - now.getTime() > THREADS_REFRESH_DAYS * DAY) continue;
        if (!canStore) { d.log?.(`Threads ${a.id}: token due for refresh, but TOKEN_ENCRYPTION_KEY is not set`); r.threadsFailed++; continue; }
        try {
          const fresh = await d.graph.refreshThreadsToken(token);
          await d.meta.setTokenEnc(a.id, d.encrypt(fresh.accessToken));
          await d.meta.setTokenMeta(a.id, { type: 'THREADS', expiresAt: new Date(now.getTime() + fresh.expiresInSec * 1000), dataAccessExpiresAt: null, scopes: [], isValid: true });
          r.threadsRefreshed++;
        } catch (err: any) {
          // The token may still work (e.g. it is under 24 h old); the health check flags it when expiry nears.
          d.log?.(`Threads ${a.id}: token refresh failed: ${err?.message ?? err}`);
          r.threadsFailed++;
        }
      } else {
        const info = await d.graph.inspectToken(token);
        if (info) { await d.meta.setTokenMeta(a.id, info); r.metaInspected++; }
      }
    } catch (err: any) {
      d.log?.(`Meta ${a.id}: upkeep failed: ${err?.message ?? err}`);
    }
  }

  // Telegram bots.
  for (const b of (await d.bots.list()).filter((x) => x.active)) {
    const token = d.token(b);
    const was = b.verify_error;
    try {
      if (!token) throw new Error(`Env var ${b.token_env} is not set`);
      const me = await retry(() => d.getMe(token));
      await d.bots.markVerified(b.id, { username: me.username, first_name: me.first_name });
      if (was) await d.changed?.('bot', b.id).catch(() => {});
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await d.bots.markVerifyError(b.id, msg);
      if (!was) await d.changed?.('bot', b.id).catch(() => {});
      r.botsBroken++;
      const name = b.username ? `@${b.username}` : `bot ${b.bot_id}`;
      await note(`bot:${b.id}`, `⚠️ Bot ${name} is broken`, `${msg}\nFix its token in /app/connections?section=telegram — channels that publish through it get no posts.`,
        { title: `⚠️ Бот ${name} не працює`, body: `${msg}\nПеревірте токен у /app/connections?section=telegram — канали, що публікують через нього, без постів.` });
    }
  }

  // Telegraph accounts (long posts are published through them).
  for (const t of (await d.telegraph.list()).filter((x) => x.active)) {
    const token = d.token(t);
    const was = t.verify_error;
    try {
      if (!token) throw new Error(`Env var ${t.token_env} is not set`);
      const info = await retry(() => d.telegraphInfo(token));
      await d.telegraph.markVerified(t.id, { short_name: info.short_name, author_name: info.author_name ?? null, author_url: info.author_url ?? null });
      if (was) await d.changed?.('telegraph', t.id).catch(() => {});
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await d.telegraph.markVerifyError(t.id, msg);
      if (!was) await d.changed?.('telegraph', t.id).catch(() => {});
      r.telegraphBroken++;
      const name = t.short_name ?? t.account_id;
      await note(`telegraph:${t.id}`, `⚠️ Telegraph account ${name} is broken`, `${msg}\nFix it in /app/connections?section=telegram — long posts cannot be published until then.`,
        { title: `⚠️ Telegraph ${name} не працює`, body: `${msg}\nВиправте в /app/connections?section=telegram — довгі пости до того не публікуються.` });
    }
  }

  // TikTok: getValidAccessToken refreshes a near-expiry access token and records a failure on the account
  // (refresh_error, which the health check reads as token_invalid).
  if (d.tiktok) {
    for (const t of (await d.tiktok.list()).filter((x) => x.active)) {
      try { await d.tiktok.getValidAccessToken(t.id); } catch (err: any) {
        d.log?.(`TikTok ${t.id}: ${err?.message ?? err}`);
        r.tiktokFailed++;
      }
    }
  }

  // MTProto sessions: reported from their stored state (see above).
  for (const s of (await d.mtproto.list()).filter((x) => x.active && x.verify_error)) {
    const name = s.username ? `@${s.username}` : s.label;
    await note(`mtproto:${s.id}`, `⚠️ MTProto session ${name} (${s.role}) is broken`,
      `${s.verify_error}\nRe-verify or replace it in /app/connections?section=telegram — ${s.role === 'tracker' ? 'channel tracking and stats' : 'the agent account'} stop until then.`,
      { title: `⚠️ MTProto-сесія ${name} (${s.role}) не працює`, body: `${s.verify_error}\nПеревірте або замініть у /app/connections?section=telegram.` });
  }
  return r;
}
