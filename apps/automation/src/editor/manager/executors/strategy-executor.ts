import type { NetworkRepository, PlaybookRow } from '../../network/network.repository';
import type { Directive } from '../directives.repository';
import { notExecutable } from './playbook-change';
import type { Applied, DirectiveExecutor, StrategyChange, VerifyResult } from './types';

/**
 * The `strategy` executor (spec 025 FR-015): the orchestrator rebuilds its playbook from the directive's brief
 * (NetworkRunner.runPlaybookBuild, an LLM run). The version it writes is `pending_owner` and carries
 * `directive_id`. Applied when the owner activates that version; the owner rejecting it rejects the directive.
 */

/** Runs the build for an orchestrator; bound late (the NetworkRunner is built after the MANAGER). */
export type PlaybookBuildFn = (orchId: string, brief: string, directiveId: string) => Promise<unknown>;

/** A late-bound port: the module binds NetworkRunner.runPlaybookBuild once the runner exists. */
export class PlaybookBuildPort {
  private fn: PlaybookBuildFn | null = null;
  bind(fn: PlaybookBuildFn): void { this.fn = fn; }
  async build(orchId: string, brief: string, directiveId: string): Promise<void> {
    if (!this.fn) throw new Error('no playbook builder is wired');
    await this.fn(orchId, brief, directiveId);
  }
}

export interface StrategyExecutorDeps {
  network: Pick<NetworkRepository, 'playbookHistory'>;
  builder: Pick<PlaybookBuildPort, 'build'>;
}

export const STRATEGY_BRIEF_MIN = 10;

export function strategyExecutor(d: StrategyExecutorDeps): DirectiveExecutor<StrategyChange> {
  const versionOf = async (dir: Pick<Directive, 'id' | 'toAgentId'>): Promise<PlaybookRow | null> =>
    (await d.network.playbookHistory(dir.toAgentId, 50)).find((v) => v.directiveId === dir.id) ?? null;
  return {
    kind: 'strategy',
    plan(dir, ctx) {
      if (!ctx.card || !ctx.net) return notExecutable('в оркестратора немає картки каналу — плейбук не побудувати');
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const brief = String(p.brief ?? dir.body ?? '').trim();
      if (brief.length < STRATEGY_BRIEF_MIN) return notExecutable('стратегія без брифу: опиши в тексті директиви (або params.brief), що змінити в плейбуку');
      return {
        kind: 'strategy', op: 'playbook_build', target: 'owner', channel_key: ctx.net.anchorKey, brief: brief.slice(0, 2000), structural: true,
        reasons: ['strategy: the orchestrator rebuilds the playbook from the directive; the owner activates the new version'],
      };
    },
    async apply(change, dir): Promise<Applied> {
      let pb = await versionOf(dir);
      if (!pb) {
        await d.builder.build(dir.toAgentId, change.brief, dir.id);
        pb = await versionOf(dir);
        if (!pb) throw new Error('the playbook build wrote no version');
      }
      const at = { playbookId: pb.id, version: pb.version };
      if (pb.status === 'active' || change.activated_at) return { noop: false, ...at };
      if (pb.status === 'pending_owner' || pb.status === 'draft') return { noop: false, pending: true, ...at };
      if (pb.status === 'rejected') return { noop: false, ownerRejected: true, ...at };
      throw new Error(`playbook v${pb.version} was superseded before the owner decided`);
    },
    /** Verified as soon as it is applied: the owner activated the version the directive asked for. */
    async verify(dir: Directive): Promise<VerifyResult> {
      const c = dir.change as StrategyChange | null;
      if (!c?.playbook_id) return { verified: false, adherence: 'not_followed', detail: { reason: 'no playbook version recorded' } };
      return { verified: true, adherence: 'followed', detail: { playbook_id: c.playbook_id, version: c.version ?? null } };
    },
  };
}
