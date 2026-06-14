// One-off TikTok onboarding: exchange an authorization code (obtained out-of-band
// via TikTok's OAuth consent screen) for tokens and persist the account.
//   Usage: npx tsx scripts/tiktok-seed.ts <authorization_code>
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { TikTokAccountsRepository } from '../src/config/tiktok-accounts.repository';
import { TikTokTokenService } from '../src/config/tiktok-token.service';

async function main() {
  const code = process.argv[2];
  if (!code) { console.error('Usage: npx tsx scripts/tiktok-seed.ts <authorization_code>'); process.exit(1); }

  const config = new ConfigService(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repo = new TikTokAccountsRepository(pool);
  const svc = new TikTokTokenService(config, repo);

  try {
    const row = await svc.exchangeCode(code);
    console.log(`TikTok account onboarded: open_id=${row.open_id} (id=${row.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
