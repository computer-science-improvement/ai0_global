import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCategory, cleanTitle, parseReadme } from './prompts-github.js';

const NANO = `# Awesome NanoBanana

## 1. Photorealism & Aesthetics

### 1.1. Hyper-Realistic Crowd Composition
*Handling complex compositions.*
<img width="400" alt="Crowd" src="https://github.com/user-attachments/assets/img-uuid-1" />

**Prompt:**
\`\`\`text
Create a hyper-realistic editorial cover.
\`\`\`
*Source: [@SebJefferies](https://x.com/SebJefferies/status/1)*

## 11. Resources
Some links, no prompts here.
`;

const SEED = `# Awesome Seedance

## 1. Cinematic Film Styles

### 1.1. Racing Movie Style
*Le Mans cinematic.*

**Prompt:**
\`\`\`
Style: Hollywood Racing. Duration: 15s.
\`\`\`

https://github.com/user-attachments/assets/vid-uuid-1

*Source: John ([@johnAGI168](https://x.com/johnAGI168)) - [Post](https://x.com/johnAGI168/status/2)*
`;

test('cleanCategory strips the leading "N. "', () => {
  assert.equal(cleanCategory('1. Photorealism & Aesthetics'), 'Photorealism & Aesthetics');
});

test('cleanTitle strips the leading "N.M. "', () => {
  assert.equal(cleanTitle('1.1. Hyper-Realistic Crowd Composition'), 'Hyper-Realistic Crowd Composition');
});

test('parseReadme: nanobanana image entry', () => {
  const rows = parseReadme(NANO, 'nanobanana');
  assert.equal(rows.length, 1); // Resources section yields nothing
  const r = rows[0];
  assert.equal(r.provider, 'nanobanana');
  assert.equal(r.category, 'Photorealism & Aesthetics');
  assert.equal(r.title, 'Hyper-Realistic Crowd Composition');
  assert.equal(r.prompt_text, 'Create a hyper-realistic editorial cover.');
  assert.equal(r.media_type, 'image');
  assert.equal(r.media_url, 'https://github.com/user-attachments/assets/img-uuid-1');
  assert.equal(r.id, r.media_url);
  assert.match(r.source, /SebJefferies/);
});

test('parseReadme: seedance video entry', () => {
  const rows = parseReadme(SEED, 'seedance');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'seedance');
  assert.equal(r.category, 'Cinematic Film Styles');
  assert.equal(r.media_type, 'video');
  assert.equal(r.media_url, 'https://github.com/user-attachments/assets/vid-uuid-1');
  assert.match(r.prompt_text, /Hollywood Racing/);
});

test('parseReadme: dedup by media_url', () => {
  const rows = parseReadme(NANO + NANO, 'nanobanana');
  assert.equal(rows.length, 1);
});
