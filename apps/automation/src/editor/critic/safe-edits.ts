import { languageFindings } from '../post/language/lexicon';
import type { TextEdit } from './spec-edits';

/**
 * Spec 063 FR-004: guards on the exact edits code applies to a post (the critic's `pass_with_edits`, the lint's fixes).
 * Review 3, pp1732: «(context window) — це ліміт» became «(context window) ліміт» — the model's edit dropped «це» and
 * the sentence broke; only lint and the publish guards ran on it. Two checks now run on every edit before it is
 * applied:
 *   • `word_dropped` — `to` has fewer word tokens than `from` (a duplicated word «що що» → «що» is fine). A word-for-word
 *     replacement («тими самі» → «ті самі», «в» → «у») keeps the count and passes;
 *   • `language_regression` — the Ukrainian lexicon / euphony check (post/language/lexicon) on the text as edited: a
 *     finding the post did not have before reverts the edit.
 * A rejected edit is recorded (`StoredCritic.edits_rejected`), never retried through a revise: the critic passed the
 * post, and the post is better as written than with a broken sentence.
 */

export type EditRejection = 'word_dropped' | 'language_regression';
export interface RejectedEdit extends TextEdit { why: EditRejection; detail?: string }

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}ʼ'’-]*/gu;

/** The word tokens of a string (lowercase): letters and digits, a hyphen or an apostrophe inside a word stays in it. */
export function wordTokens(s: string): string[] {
  return (s.match(TOKEN) ?? []).map((t) => t.toLowerCase().replace(/['’]/g, 'ʼ'));
}

/** Does `to` lose a word of `from`? Directly repeated words of `from` («що що») count once. */
export function dropsWord(from: string, to: string): boolean {
  const collapse = (ts: string[]) => ts.filter((t, i) => t !== ts[i - 1]);
  return collapse(wordTokens(from)).length > collapse(wordTokens(to)).length;
}

const key = (f: { code: string; excerpt: string }) => `${f.code}:${f.excerpt.toLowerCase()}`;

/**
 * Splits the edits into the safe ones and the rejected ones. `text` is the post as the reader sees it: the lexicon
 * runs on it with the accepted edits applied one by one, so an edit that makes a new finding is reverted on its own.
 */
export function guardEdits(text: string, edits: readonly TextEdit[]): { ok: TextEdit[]; rejected: RejectedEdit[] } {
  const ok: TextEdit[] = [];
  const rejected: RejectedEdit[] = [];
  let cur = text;
  let known = new Set(languageFindings(cur).map(key));
  for (const e of edits) {
    if (!e.from || e.from === e.to) continue;
    if (dropsWord(e.from, e.to)) { rejected.push({ ...e, why: 'word_dropped' }); continue; }
    // An edit whose `from` is not in the plain text (markup, an alt text) cannot be re-checked in place: it passes on the word guard.
    const at = cur.indexOf(e.from);
    if (at < 0) { ok.push(e); continue; }
    const next = `${cur.slice(0, at)}${e.to}${cur.slice(at + e.from.length)}`;
    const found = languageFindings(next);
    const fresh = found.find((f) => !known.has(key(f)));
    if (fresh) { rejected.push({ ...e, why: 'language_regression', detail: fresh.message.slice(0, 160) }); continue; }
    ok.push(e);
    cur = next;
    known = new Set(found.map(key));
  }
  return { ok, rejected };
}
