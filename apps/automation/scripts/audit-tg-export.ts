/**
 * Spec 037 FR-001: `npm run audit:tg-export -- <export dir | folder of export dirs> […] [--tz Europe/Kyiv]`
 *
 * Parses Telegram Desktop HTML exports (messages*.html), runs every registered integrity check (the channels of one
 * run are treated as one network group) and prints a markdown report per channel. Offline: no DB, no network, no LLM.
 * The DEV-channel owner decisions (address «ви», hashtags off) are applied as the style of every channel.
 */
import { findExportDirs, parseTelegramExportDir } from '../src/editor/post/integrity/tg-export';
import { auditPosts, renderAuditMarkdown } from '../src/editor/post/integrity/audit-report';
import { implementedCodes } from '../src/editor/post/integrity/registry';

const args = process.argv.slice(2);
const tzAt = args.indexOf('--tz');
const timezone = tzAt >= 0 ? args[tzAt + 1] : 'Europe/Kyiv';
const paths = tzAt >= 0 ? args.filter((_a, i) => i !== tzAt && i !== tzAt + 1) : args;
if (!paths.length) {
  console.error('usage: npm run audit:tg-export -- <export dir | folder of export dirs> […] [--tz Europe/Kyiv]');
  process.exit(2);
}

const dirs = findExportDirs(paths);
if (!dirs.length) {
  console.error(`no Telegram export (messages.html) under: ${paths.join(', ')}`);
  process.exit(1);
}
const posts = dirs.flatMap((d) => parseTelegramExportDir(d, { timezone }));
const rows = auditPosts(posts, () => ({ timezone, style: { address: 'vy', hashtags: 'off' } }));
console.log(renderAuditMarkdown(rows, { title: `Content integrity audit: ${dirs.length} export(s), ${posts.length} posts`, codes: [...implementedCodes()] }));
