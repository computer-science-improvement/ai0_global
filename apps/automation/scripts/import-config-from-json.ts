#!/usr/bin/env tsx
//
// One-shot CLI: import a `channels.<env>.json` config file into the live DB.
//
// Mirrors JsonImporterService logic but bypasses the sentinel guard, so it
// can be re-run safely as data evolves (upsert by channel_key, ON CONFLICT
// DO NOTHING for forwards + strategies — never overwrites enabled state of
// existing bindings).
//
// SAFETY: by default, imported strategies land with `enabled = false`.
// The operator enables them selectively from the dashboard. Override with
// --strategies-enabled=true if you really want them firing immediately.
//
// Usage:
//   pnpm --filter automation exec tsx scripts/import-config-from-json.ts \
//     --file config/channels.local.full-backup.json \
//     [--strategies-enabled false]   # default false
//
// Reads DB credentials from the SAME env vars the automation service uses
// (POSTGRES_HOST/PORT/DB/USER/PASSWORD), so it Just Works on any machine
// with the .env loaded.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Pool, PoolClient } from 'pg';

/**
 * Minimal .env loader — sidesteps adding `dotenv` for one CLI script.
 * Handles KEY=VALUE lines, `# comments`, empty lines, single/double-quoted
 * values. Does NOT do variable interpolation or multi-line values; we
 * don't need them.
 */
function loadEnvFile(path: string, override = false): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// ── Load .env (root) then apps/automation/.env if present. Later wins. ──
loadEnvFile(resolve(__dirname, '../../../.env'));
loadEnvFile(resolve(__dirname, '../.env'), true);

interface CliArgs {
  file:               string;
  strategiesEnabled:  boolean;
}

interface RawJsonConfig {
  bots?: Record<string, { platform?: string; tokenEnv: string }>;
  channels?: Record<string, {
    platform?: string;
    chatId?:   string;
    botId?:    string;
    forwardRoutes?: Array<{ topic: string; channelId: string; description: string }>;
  }>;
  strategies?: Array<{
    id:        string;
    type:      string;
    channelId: string;
    schedule:  string;
    params?:   Record<string, unknown>;
  }>;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let file: string | null = null;
  let strategiesEnabled = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') {
      file = args[++i];
    } else if (a.startsWith('--file=')) {
      file = a.slice('--file='.length);
    } else if (a === '--strategies-enabled') {
      strategiesEnabled = args[++i] === 'true';
    } else if (a.startsWith('--strategies-enabled=')) {
      strategiesEnabled = a.slice('--strategies-enabled='.length) === 'true';
    } else if (a === '-h' || a === '--help') {
      console.log(`
Import a channels.<env>.json config file into the DB.

Usage:
  tsx scripts/import-config-from-json.ts --file <path> [--strategies-enabled true|false]

Options:
  --file <path>                 JSON file to import (required)
  --strategies-enabled <bool>   Enable strategies on insert. Default: false
                                (cost-safety — enable selectively from UI).
`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!file) {
    console.error('Missing required --file <path>');
    process.exit(2);
  }
  return { file, strategiesEnabled };
}

function makePool(): Pool {
  const host     = process.env.POSTGRES_HOST     ?? 'localhost';
  const port     = parseInt(process.env.POSTGRES_PORT ?? '5432', 10);
  const database = process.env.POSTGRES_DB       ?? 'ai0global';
  const user     = process.env.POSTGRES_USER     ?? 'ai0';
  const password = process.env.POSTGRES_PASSWORD ?? 'changeme';
  console.log(`DB: ${user}@${host}:${port}/${database}`);
  return new Pool({ host, port, database, user, password, max: 4 });
}

async function importTx(
  client: PoolClient,
  raw: RawJsonConfig,
  strategiesEnabled: boolean,
): Promise<{ bots: number; channels: number; strategies: number; forwards: number }> {
  let botsCount = 0, chCount = 0, sCount = 0, fwCount = 0;

  // 1. Bots — pre-load existing once, then insert missing.
  const { rows: existingBots } = await client.query<{ id: string; bot_id: string }>(
    `SELECT id, bot_id FROM my_bots`,
  );
  const botExtToUuid = new Map(existingBots.map(b => [b.bot_id, b.id]));

  for (const [botId, b] of Object.entries(raw.bots ?? {})) {
    if (botExtToUuid.has(botId)) {
      console.log(`  bot ${botId} — already exists, skipping`);
      continue;
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO my_bots (bot_id, token_env, platform)
       VALUES ($1, $2, COALESCE($3, 'telegram'))
       RETURNING id`,
      [botId, b.tokenEnv, b.platform ?? null],
    );
    botExtToUuid.set(botId, rows[0].id);
    botsCount++;
    console.log(`  bot ${botId} ← inserted`);
  }

  // 2. Channels — `kind` derived from channelKey: '@' → public, '-' → private.
  const channelKeyToId = new Map<string, string>();
  for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
    const isPrivate = channelKey.startsWith('-');
    const botUuid   = ch.botId ? botExtToUuid.get(ch.botId) ?? null : null;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, username, tg_chat_id, kind, bot_id, is_mine, poll_tier)
       VALUES ($1, $2, $3, $4, $5, true, 'warm')
       ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO UPDATE SET
         username   = EXCLUDED.username,
         tg_chat_id = EXCLUDED.tg_chat_id,
         kind       = EXCLUDED.kind,
         bot_id     = EXCLUDED.bot_id,
         is_mine    = EXCLUDED.is_mine
       RETURNING id`,
      [
        channelKey,
        isPrivate ? null : channelKey.replace(/^@/, ''),
        isPrivate ? (ch.chatId ?? channelKey) : null,
        isPrivate ? 'private' : 'public',
        botUuid,
      ],
    );
    channelKeyToId.set(channelKey, rows[0].id);
    chCount++;
    console.log(`  channel ${channelKey} ← upserted (id=${rows[0].id.slice(0, 8)}…)`);
  }

  // 3. Forward routes.
  for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
    const sourceId = channelKeyToId.get(channelKey);
    if (!sourceId) continue;
    for (const route of ch.forwardRoutes ?? []) {
      const targetId = channelKeyToId.get(route.channelId);
      if (!targetId) {
        console.warn(`  forward ${channelKey} → ${route.channelId}: target not in channels map, skipped`);
        continue;
      }
      const { rowCount } = await client.query(
        `INSERT INTO forward_routes (source_channel_id, target_channel_id, topic, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_channel_id, topic) DO NOTHING`,
        [sourceId, targetId, route.topic, route.description],
      );
      if ((rowCount ?? 0) > 0) {
        fwCount++;
        console.log(`  forward ${channelKey} →[${route.topic}]→ ${route.channelId} ← inserted`);
      }
    }
  }

  // 4. Strategies — IMPORTANT: enabled defaults to FALSE.
  for (const s of raw.strategies ?? []) {
    const channelId = channelKeyToId.get(s.channelId);
    if (!channelId) {
      console.warn(`  strategy ${s.id}: channel ${s.channelId} not in map, skipped`);
      continue;
    }
    const { rowCount } = await client.query(
      `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (ext_id) DO NOTHING`,
      [s.id, s.type, channelId, s.schedule, JSON.stringify(s.params ?? {}), strategiesEnabled],
    );
    if ((rowCount ?? 0) > 0) {
      sCount++;
      const label = strategiesEnabled ? 'ENABLED' : 'paused';
      console.log(`  strategy ${s.id} (${s.type} @ ${s.schedule}) ← inserted [${label}]`);
    }
  }

  return { bots: botsCount, channels: chCount, strategies: sCount, forwards: fwCount };
}

async function main() {
  const { file, strategiesEnabled } = parseArgs();
  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  console.log(`\nImporting from: ${filePath}`);
  console.log(`Strategies enabled on insert: ${strategiesEnabled}`);

  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as RawJsonConfig;
  console.log(`\nSource shape: ` +
    `${Object.keys(raw.bots ?? {}).length} bot(s), ` +
    `${Object.keys(raw.channels ?? {}).length} channel(s), ` +
    `${(raw.strategies ?? []).length} strategy/-ies\n`);

  const pool = makePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await importTx(client, raw, strategiesEnabled);
    await client.query('COMMIT');
    console.log(`\nDone. Inserted: ` +
      `bots=${counts.bots}, channels=${counts.channels}, ` +
      `forwards=${counts.forwards}, strategies=${counts.strategies}`);
    if (counts.strategies > 0 && !strategiesEnabled) {
      console.log(
        `\nNOTE: strategies were imported as PAUSED. Enable them from ` +
        `/strategies in the dashboard (or PATCH /api/strategies/:id { enabled: true }).`,
      );
    }
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error(`\nImport failed; rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
