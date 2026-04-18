/* eslint-disable no-console */
/**
 * One-time bootstrap: prints a gramjs StringSession for TELEGRAM_SESSION_STRING.
 *
 * Usage (from apps/automation):
 *   npx ts-node scripts/generate-telegram-session.ts
 *
 * Requires TELEGRAM_API_ID and TELEGRAM_API_HASH in env (or enter via prompt).
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as input from 'input';

async function main() {
  const apiId   = parseInt(process.env.TELEGRAM_API_ID ?? await input.text('API_ID: '), 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? await input.text('API_HASH: ');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber:  async () => await input.text('Phone (+380...): '),
    password:     async () => await input.text('2FA password (if any): '),
    phoneCode:    async () => await input.text('Code from Telegram: '),
    onError:      (err) => console.error(err),
  });

  console.log('\n--- TELEGRAM_SESSION_STRING ---');
  console.log(client.session.save());
  console.log('-------------------------------\n');
  console.log('Copy the line above into your .env');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
