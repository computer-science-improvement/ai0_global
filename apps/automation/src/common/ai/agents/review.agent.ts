import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgent } from './claude.agent';
import { Skill } from '../skills/skill.interface';
import { REVIEW_SKILL } from '../skills/review.skill';
import { buildPrompt } from '../prompt-builder';
import { cleanFinalText } from '../post-generation.helpers';
import { validatePost } from '../validators/post.validator';
import { FEATURES } from '../usage/features';

const REVIEW_MODEL = 'claude-sonnet-4-6';
/** Ukrainian posts run ~2–3 chars/token; 2048 covers the 4096-char Telegram max. */
const REVIEW_MAX_TOKENS = 2048;

const REVIEW_BASE = `ROLE: You are a Ukrainian text proofreader for a Telegram channel.
Apply the rules below. Return the corrected post and nothing else.`;

@Injectable()
export class ReviewAgent {
  private readonly logger = new Logger(ReviewAgent.name);

  constructor(private readonly claude: ClaudeAgent) {}

  /**
   * Review a finished post.
   * @param text     The post to review.
   * @param skills   Channel-specific skills (tone, audience, naming rules).
   *                 REVIEW_SKILL is always included as the base.
   */
  async review(text: string, skills: Skill[] = []): Promise<string> {
    if (!this.claude.available) return text;

    const prompt = buildPrompt(REVIEW_BASE, [REVIEW_SKILL, ...skills]);
    this.logger.debug(`Review skills: [${prompt.appliedSkills.join(', ')}]`);

    const { text: result, stopReason } = await this.claude.chatWithMeta(
      [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: text },
      ],
      { feature: FEATURES.reviewPost, model: REVIEW_MODEL, maxTokens: REVIEW_MAX_TOKENS },
    );

    if (!result) {
      this.logger.warn('Review returned null — using original');
      return text;
    }

    // A review cut off at the token cap is a truncated post — publishing it
    // would silently drop the ending. Keep the (already valid) draft instead.
    if (stopReason === 'max_tokens') {
      this.logger.warn(`Review truncated (stop_reason=max_tokens, cap ${REVIEW_MAX_TOKENS}) — using original`);
      return text;
    }

    // Same cleanup + validation the generation path applies: strip preambles /
    // stray markdown, then reject refusals, meta-commentary, SKIP_POST, empty
    // or too-short/too-long output. The reviewer may only ever improve a draft.
    const cleaned = cleanFinalText(result);
    const verdict = validatePost(cleaned);
    if (!verdict.valid) {
      this.logger.warn(`Review output rejected (${verdict.reason}) — using original`);
      return text;
    }

    return cleaned;
  }
}
