# Cross-posting for All Strategies (Phase 2b complete) — Design

**Goal:** Every content strategy can cross-post to attached Meta targets (Instagram / Facebook / Threads) after its Telegram publish. Concretely requested: recipes → IG+FB+Threads (IG needs a mirror payload), the image-prompt strategies (ai0-prompts, curated-prompts) → IG+FB+Threads, and all strategies feeding the @ai0_global channel → Threads. Chosen scope (user-approved): wire **all** remaining custom-`execute()` strategies, so attaching a target to any channel in the UI just works.

## Context (already built, unchanged)

- `meta_crosspost_targets` is keyed by **channel** (platform, meta_account_id, mode mirror|teaser, enabled). The dashboard `CrosspostSection` manages targets per channel. **No DB/API/UI changes in this project.**
- `CrossPostService.afterPublish(input)` with `input = { channelKey, messageId, mirror?: {text, tags, imageUrl?}, teaser?: {lines, imageUrl?} }`. For each enabled target it picks content by the target's mode; **if the caller didn't supply that mode's payload the target is skipped**. Per-account cooldown; failures isolated; never throws into the publish path.
- Instagram targets are **mirror-only** (API-enforced) and the IG publisher **requires a public `imageUrl`**.
- Already calling `afterPublish`: generic `ContentStrategyRunner` (mirror), `ai0-news` (mirror), `recipes` (teaser only).

## Changes

### 1. `CrossPostService` hardening — skip imageless Instagram targets

In the per-target loop, when `t.platform === 'instagram'` and the resolved content has no `imageUrl`, **skip with a debug log** ("instagram target skipped — no image") instead of dispatching (which would throw inside the IG publisher and log an error). Text-only strategies with an IG target attached to their channel stay quiet. Unit-tested.

### 2. recipes — add a mirror payload (enables Instagram)

Keep the existing teaser, add `mirror` so per-target mode selection has both:

```typescript
await this.crossPost.afterPublish({
  channelKey: channelId,
  messageId,
  mirror: { text: caption, tags: row.category ? [row.category] : [], imageUrl: row.image_url },
  teaser: { lines: [uk.titleUk, this.nutritionLine(row)], imageUrl: row.image_url },
});
```

`caption` is the already-built TG caption (dish + ingredients, HTML — `buildMirrorCaption` strips it). IG target = mirror with the dish photo; FB/Threads keep teaser (or mirror, operator's choice per target).

### 3. ai0-prompts — wire afterPublish (mirror)

After the existing `publishPrompt` + `markPosted` + notifier block:

```typescript
await this.crossPost.afterPublish({
  channelKey: channelId,
  messageId,
  mirror: { text: message.caption, tags: [category], imageUrl: row.id },
});
```

`row.id` is the PromptHero **image URL** (the strategy already downloads the TG image from it) — the implementation plan verifies this at the call site before relying on it. Caveat (accepted): Meta fetches the URL itself; if PromptHero's CDN refuses, the IG/FB image post fails **isolated + logged**, TG unaffected.

### 4. curated-prompts — wire afterPublish (mirror)

After its publish block (both video and image paths share it):

```typescript
await this.crossPost.afterPublish({
  channelKey: channelId,
  messageId,
  mirror: {
    text: caption,
    tags: row.category ? [row.category] : [],
    imageUrl: row.media_type === 'image' ? row.media_url : undefined,
  },
});
```

Video rows cross-post as text (FB/Threads); IG is skipped by the new no-image rule.

### 5. The remaining 7 custom strategies — one mirror call each

Same appended call after each strategy's successful TG publish, with that strategy's real post text/tags/public image (exact fields pinned from each publish site in the implementation plan):

| Strategy | text | tags | imageUrl |
|---|---|---|---|
| `ua-news` | the published post text | item tags | item image URL if public, else undefined |
| `quotes` | quote text + author | category if set | undefined (text-only) |
| `facts` | fact content | category if set | `image_url` if present |
| `game-channel` | the built post text | `[item.type]` | `item.imageUrl` if present |
| `pdr-quiz` | question text (+ answers block as published) | none | `image_url` if present |
| `assets` | the built post text | category if set | undefined unless a public URL exists |
| `motivation-biography` | the biography post text | none | undefined |

Rules for every wiring: the call comes **after** the TG publish succeeds and after `markPosted`/logging, inside the existing success path; it is `await`ed but relies on `afterPublish`'s internal isolation (it never throws); no behavior change when a channel has no targets (the service returns immediately).

### 6. Constructor injections

Each newly-wired strategy gains `private readonly crossPost: CrossPostService` in its constructor. `PublishersModule` (exporting `CrossPostService`) is `@Global`-importable the same way recipes/ai0-news already inject it — follow the identical import pattern.

## Out of scope

- No new modes, platforms, or per-strategy target overrides (targets stay per-channel).
- No image hosting/proxying for ai0-prompts (accept the direct-URL caveat).
- No dashboard changes.
- Attaching the actual targets (recipes → IG/FB/Threads, prompt channels → IG/FB/Threads, @ai0_global → Threads) is operator config in the existing UI after deploy.

## Testing

- **Unit (new):** `CrossPostService` skips IG targets without an image (fake targets + dispatcher; assert dispatcher not called for IG, called for FB/Threads).
- **Unit (existing):** crosspost-content tests unchanged; recipes strategy tests already mock `afterPublish` — extend the mock assertion to check both `mirror` and `teaser` are passed; curated-prompts strategy test gains a `crossPost` fake (constructor change).
- **Verify:** full `node:test` suite + `tsc --noEmit` + `nest build`.

## Cost / safety

Additive calls after the TG publish; the live Telegram path is untouched. Build + tests only — no automation restart, no posting, no Claude calls (the user runs the real smoke test). A strategy on a channel with zero targets is a no-op.
