import { Skill } from './skill.interface';

/**
 * Defines a contract with the model for unrecoverable cases.
 * Instead of returning a refusal, explanation, or broken text —
 * the model returns a single machine-readable signal: SKIP_POST
 */
export const SKIP_SIGNAL_SKILL: Skill = {
  name: 'skip-signal',
  instructions: `
## Failure Contract

If for ANY reason you cannot produce a valid post — return ONLY this exact word, nothing else:

SKIP_POST

Trigger this signal when:
- The input is too short, empty, or unreadable to produce a post
- The input is an error message, HTML error page, or system output (not article content)
- The content is not a news article (e.g. a login page, a 404, an ad)
- You would otherwise write a refusal, apology, or explanation

SKIP_POST means: "I received this input but cannot produce a usable post from it."

Rules:
- Return SKIP_POST as a single word with no punctuation, no explanation, no surrounding text.
- Never return SKIP_POST when you CAN produce a post — only when you genuinely cannot.
- Uncomfortable or sensitive topics must be formatted anyway — do not use SKIP_POST for them.`,
};
