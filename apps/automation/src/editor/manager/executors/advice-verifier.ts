import type { Pool } from 'pg';
import type { Directive } from '../directives.repository';
import type { DirectiveVerifier, VerifyResult } from './types';

/**
 * Spec 046 FR-003: followed advice is no longer taken on the orchestrator's word. Advice has no executor; it is
 * followed when the orchestrator changed something the advice can live in — a new playbook version of its own
 * (active or waiting for the owner) after the advice was filed. Without one it is `not_followed` after
 * ADVICE_VERIFY_GIVE_UP_MS (review 2: "оновлюю бриф" with no playbook change, 5/10 applied only self-reported).
 */
export const ADVICE_VERIFY_GIVE_UP_MS = 48 * 3600_000;

export function adviceVerifier(pool: Pick<Pool, 'query'>, now: () => Date = () => new Date()): DirectiveVerifier {
  return {
    kind: 'advice',
    async verify(dir: Directive): Promise<VerifyResult> {
      const { rows } = await pool.query(
        `SELECT version, status, created_at FROM playbooks
          WHERE agent_id = $1 AND created_by = 'orchestrator' AND status <> 'draft' AND created_at >= $2
          ORDER BY version DESC LIMIT 3`, [dir.toAgentId, dir.createdAt]);
      if (rows.length) {
        return { verified: true, adherence: 'followed', detail: { playbook_versions: rows.map((r) => ({ version: Number(r.version), status: r.status })) } };
      }
      const since = (dir.appliedAt ?? dir.createdAt).getTime();
      if (now().getTime() - since > ADVICE_VERIFY_GIVE_UP_MS) {
        return { verified: false, adherence: 'not_followed', detail: { reason: 'no playbook change by the orchestrator after the advice' } };
      }
      return { pending: true };
    },
  };
}
