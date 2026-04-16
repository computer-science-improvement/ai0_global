import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgent } from './claude.agent';
import { Skill } from '../skills/skill.interface';
import { REVIEW_SKILL } from '../skills/review.skill';
import { buildPrompt } from '../prompt-builder';

const REVIEW_MODEL = 'claude-sonnet-4-6';

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

    const result = await this.claude.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: text },
      ],
      { model: REVIEW_MODEL, maxTokens: 1024 },
    );

    if (!result) {
      this.logger.warn('Review returned null — using original');
      return text;
    }

    // Guard: reviewer must never return SKIP_POST or garbage
    if (result.trim() === 'SKIP_POST' || result.trim().length < 20) {
      this.logger.warn('Review returned invalid text — using original');
      return text;
    }

    return result;
  }
}
