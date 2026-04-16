import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface PdrAnswer {
  num:  number;
  text: string;
}

export interface PdrQuestionRow {
  id:                 string;
  question_id:        number;
  ticket_number:      number;
  question_num:       number;
  text:               string;
  image_url:          string | null;
  answers:            PdrAnswer[];
  correct_answer_num: number;
  explanation:        string;
}

@Injectable()
export class PdrQuizRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Get the next unposted question in ticket/question order */
  async getNext(channelId: string): Promise<PdrQuestionRow | null> {
    const { rows } = await this.pool.query<PdrQuestionRow>(
      `SELECT id, question_id, ticket_number, question_num,
              text, image_url, answers, correct_answer_num, explanation
       FROM pdr_questions
       WHERE NOT (posted ? $1)
       ORDER BY ticket_number, question_num
       LIMIT 1`,
      [channelId],
    );
    return rows[0] ?? null;
  }

  async markPosted(id: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pdr_questions SET posted = posted || jsonb_build_object($2::text, NOW()) WHERE id = $1`,
      [id, channelId],
    );
  }
}
