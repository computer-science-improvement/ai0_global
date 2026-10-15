import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelSlug, exportDateToIso, findExportDirs, parseTelegramExportDir, parseTelegramExportHtml } from './tg-export';

// A synthetic Telegram Desktop export page with every construct the parser reads (no real channel data).
const msg = (id: number, date: string, inner: string, joined = false) => `
     <div class="message default clearfix${joined ? ' joined' : ''}" id="message${id}">
      <div class="body">
       <div class="pull_right date details" title="${date}">
12:00
       </div>
${inner}
      </div>
     </div>`;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Exported Data</title></head><body>
  <div class="page_wrap">
   <div class="page_header"><div class="content"><div class="text bold">
Тестовий Канал | DEV
   </div></div></div>
   <div class="page_body chat_page"><div class="history">
     <div class="message service" id="message-1"><div class="body details">
7 October 2026
     </div></div>
${msg(10, '07.10.2026 14:02:41 UTC+02:00', `
       <div class="media_wrap clearfix">
        <a class="photo_wrap clearfix pull_left" href="photos/photo_1.jpg"><img class="photo" src="photos/photo_1_thumb.jpg"/></a>
       </div>
       <div class="text">
<strong>Apple і LG роблять хаб</strong><br><br>Анонс 13 жовтня &amp; більше.<br><br>• Замок<br>• Термостат<br><br>Деталі: <a href="https://example.com/a">стаття</a><br><br>→ <a href="https://techcrunch.com/2026/10/06/x/">TechCrunch</a><br><br><a href="" onclick="return ShowHashtag(&quot;apple&quot;)">#apple</a> <a href="" onclick="return ShowHashtag(&quot;гаджети&quot;)">#гаджети</a>
       </div>`)}
${msg(11, '07.10.2026 14:02:42 UTC+02:00', `
       <div class="media_wrap clearfix">
        <a class="photo_wrap clearfix pull_left" href="photos/photo_2.jpg"><img class="photo" src="photos/photo_2_thumb.jpg"/></a>
       </div>`, true)}
${msg(12, '07.10.2026 14:02:42 UTC+02:00', `
       <div class="media_wrap clearfix">
        <a class="photo_wrap clearfix pull_left" href="photos/photo_3.jpg"><img class="photo" src="photos/photo_3_thumb.jpg"/></a>
       </div>`, true)}
${msg(13, '08.10.2026 21:31:10 UTC+02:00', `
       <div class="media_wrap clearfix">
        <div class="media_poll">
         <div class="question bold">
Скільки параметрів активні?
         </div>
         <div class="details">
Anonymous quiz
         </div>
         <div class="answer">
- 49 мільярдів <span class="details">1 vote, chosen vote</span>
         </div>
         <div class="answer">
- Усі 1,05 трлн
         </div>
         <div class="total details&#x09;">
1 vote
         </div>
        </div>
       </div>`)}
${msg(14, '09.10.2026 12:01:06 UTC+02:00', `
<div class="text rich_message" data-rich-message="14" data-rich-part="false" dir="auto">
        <figure class="rich_block rich_media_item" data-rich-kind="photo"><div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/p.jpg"></a></div></figure>
        <p class="rich_block rich_paragraph" data-rich-kind="paragraph" dir="auto">
<strong>Gemini Agent для бізнесу</strong>
        </p>
        <h2 class="rich_block rich_heading" data-level="2" data-rich-kind="heading">
Що всередині
        </h2>
        <ul class="rich_block rich_list" data-rich-kind="list">
         <li class="rich_list_item"><div class="rich_list_content"><p class="rich_block rich_paragraph">
Перший пункт
         </p></div></li>
         <li class="rich_list_item"><div class="rich_list_content"><p class="rich_block rich_paragraph">
Другий пункт
         </p></div></li>
        </ul>
        <blockquote class="rich_block rich_quote" data-rich-kind="quote-blocks"><div class="rich_quote_body"><p class="rich_block rich_paragraph">
Цитата
        </p></div></blockquote>
        <footer class="rich_block rich_footer" data-rich-kind="footer" dir="auto">
Джерело: Financial Times
        </footer>
        <p class="rich_block rich_paragraph" data-rich-kind="paragraph" dir="auto">
→ <a href="https://www.marktechpost.com/">MarkTechPost</a>
        </p>
</div>
       <table class="bot_buttons_table"><tbody><tr><td class="bot_button_row">
        <div class="bot_button"><a href="https://telegra.ph/x-10-09"><div>
Читати
        </div></a></div>
       </td></tr></tbody></table>`)}
${msg(15, '10.10.2026 09:00:00 UTC+02:00', `
       <div class="text">
За добу на <strong>itch.io</strong> нове.
       </div>`)}
${msg(16, '10.10.2026 10:00:00 UTC+02:00', `
       <div class="text">
<strong>За добу на </strong><a href="https://itch.io">itch.io</a><strong> три новинки.</strong><br>Далі.
       </div>`)}
   </div></div>
  </div></body></html>`;

test('dates: the export title keeps its UTC offset', () => {
  assert.equal(exportDateToIso('07.10.2026 14:02:41 UTC+02:00'), '2026-10-07T14:02:41+02:00');
  assert.equal(exportDateToIso('25.10.2026 03:00:00 UTC-04:30'), '2026-10-25T03:00:00-04:30');
  assert.equal(exportDateToIso('07.10.2026 14:02:41'), '2026-10-07T14:02:41Z');
  assert.equal(exportDateToIso('yesterday'), null);
});

test('channel slug: Ukrainian transliteration, lowercase, dashes', () => {
  assert.equal(channelSlug('AI Шукає Новини | DEV'), 'ai-shukaie-novyny-dev');
  assert.equal(channelSlug('Біржа Ігор | DEV'), 'birzha-ihor-dev');
  assert.equal(channelSlug('|||'), 'channel');
});

test('parser: text, lead, links, source line, hashtags, media; album parts join the post; service messages skipped', () => {
  const posts = parseTelegramExportHtml(PAGE);
  assert.deepEqual(posts.map((p) => p.id), ['testovyi-kanal-dev:10', 'testovyi-kanal-dev:13', 'testovyi-kanal-dev:14', 'testovyi-kanal-dev:15', 'testovyi-kanal-dev:16']);
  const p = posts[0];
  assert.equal(p.channel, 'Тестовий Канал | DEV');
  assert.equal(p.publishedAt, '2026-10-07T14:02:41+02:00');
  assert.equal(p.timezone, 'Europe/Kyiv');
  assert.equal(p.lead, 'Apple і LG роблять хаб');
  assert.equal(p.text, 'Apple і LG роблять хаб\n\nАнонс 13 жовтня & більше.\n\n• Замок\n• Термостат\n\nДеталі: стаття\n\n→ TechCrunch\n\n#apple #гаджети');
  assert.deepEqual(p.links, [{ text: 'стаття', url: 'https://example.com/a' }, { text: 'TechCrunch', url: 'https://techcrunch.com/2026/10/06/x/' }]);
  assert.equal(p.sourceUrl, 'https://techcrunch.com/2026/10/06/x/');
  assert.deepEqual(p.hashtags, ['apple', 'гаджети']);
  assert.deepEqual(p.media, { kind: 'photo', count: 3 });
  assert.deepEqual(p.messageIds, [10, 11, 12]);
  assert.deepEqual(p.buttons, []);
});

test('parser: polls keep question, options (vote counts stripped), quiz and anonymity', () => {
  const poll = parseTelegramExportHtml(PAGE)[1];
  assert.equal(poll.text, '');
  assert.equal(poll.media, null);
  assert.deepEqual(poll.poll, { question: 'Скільки параметрів активні?', options: ['49 мільярдів', 'Усі 1,05 трлн'], kind: 'quiz', anonymous: true });
});

test('parser: rich messages block by block (media item counted, lead after it), buttons', () => {
  const r = parseTelegramExportHtml(PAGE)[2];
  assert.equal(r.lead, 'Gemini Agent для бізнесу');
  assert.equal(r.text, 'Gemini Agent для бізнесу\n\nЩо всередині\n\n• Перший пункт\n• Другий пункт\n\nЦитата\n\nДжерело: Financial Times\n\n→ MarkTechPost');
  assert.deepEqual(r.media, { kind: 'photo', count: 1 });
  assert.equal(r.sourceUrl, 'https://www.marktechpost.com/');
  assert.deepEqual(r.buttons, [{ text: 'Читати', url: 'https://telegra.ph/x-10-09' }]);
});

test('parser: the lead is the first line only when the text opens bold (bold split by a link stays one lead)', () => {
  const [, , , notBold, split] = parseTelegramExportHtml(PAGE);
  assert.equal(notBold.lead, undefined);
  assert.equal(split.lead, 'За добу на itch.io три новинки.');
  assert.deepEqual(split.links, [{ text: 'itch.io', url: 'https://itch.io' }]);
  assert.equal(split.sourceUrl, undefined, 'only a link right after «→» is the source');
});

test('export dirs: a dir with messages.html, or a folder of them; pages in order', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-export-'));
  const a = join(root, 'ChatExport_a');
  mkdirSync(a);
  writeFileSync(join(a, 'messages.html'), PAGE);
  writeFileSync(join(a, 'messages2.html'), PAGE.replace(/message1(\d)"/g, 'message2$1"'));
  mkdirSync(join(root, 'not-an-export'));
  assert.deepEqual(findExportDirs([root]), [a]);
  assert.deepEqual(findExportDirs([a]), [a]);
  const posts = parseTelegramExportDir(a);
  assert.equal(posts.length, 10);
  assert.equal(posts[5].id, 'testovyi-kanal-dev:20');
});
