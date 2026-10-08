// Spec 026 FR-002/FR-003/FR-015: the "Public page" card on /app/landing. The owner
// edits the Telegram account that takes ad DMs, the prefilled DM text and the
// white-label switch; the right side previews the exact messages and links the
// public page will use. The preview is rendered by the server (the same builder the
// public page uses), from the unsaved draft, debounced.

import { useEffect, useState, type JSX } from 'react';
import { Panel } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import {
  useLandingAdminConfig, useLandingDmPreview, useSaveLandingConfig,
  type LandingAdminConfig, type LandingConfigIssue,
} from '../../api/landing';
import {
  AD_TEMPLATE_MAX, charCount, configPatch, draftFromConfig, previewDraft, type LandingConfigDraft,
} from '../../lib/landing-config-draft';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const SOURCE_LABEL = { setting: 'set here', agent_session: 'the agent account' } as const;

export function PublicPageCard(): JSX.Element {
  const { data: cfg, isLoading, error } = useLandingAdminConfig();
  const save = useSaveLandingConfig();
  const [draft, setDraft] = useState<LandingConfigDraft | null>(null);

  // The draft starts from the saved state once; a background refetch never wipes an edit.
  useEffect(() => { if (cfg && draft === null) setDraft(draftFromConfig(cfg)); }, [cfg, draft]);

  const body = draft ? previewDraft(draft) : null;
  const debounced = useDebounced(body ? JSON.stringify(body) : null, 300);
  const preview = useLandingDmPreview(debounced ? JSON.parse(debounced) : null);

  if (isLoading || (!draft && !error)) {
    return <Panel title="Public page"><div className="la-skeleton" style={{ height: 120 }} /></Panel>;
  }
  if (error || !cfg || !draft) {
    return (
      <Panel title="Public page">
        <div className="text-body-sm" style={{ color: 'var(--color-danger)' }}>
          Couldn’t load the public page settings{error ? `: ${(error as Error).message}` : ''}
        </div>
      </Panel>
    );
  }

  const patch = configPatch(cfg, draft);
  const dirty = Object.keys(patch).length > 0;
  const issues: LandingConfigIssue[] = preview.data?.issues ?? [];
  const issueFor = (path: LandingConfigIssue['path']) => issues.find((i) => i.path === path)?.message;
  const previewCurrent = debounced === (body ? JSON.stringify(body) : null) && !preview.isFetching;
  const canSave = dirty && !save.isPending && previewCurrent && (preview.data?.valid ?? false);
  const len = charCount(draft.message);

  const onSave = () => {
    save.mutate(patch, {
      onSuccess: (next: LandingAdminConfig) => {
        setDraft(draftFromConfig(next));
        toast.success('Public page settings saved');
      },
    });
  };

  return (
    <Panel title="Public page" action={<StatusBadge cfg={cfg} />}>
      <div className="pp-grid">
        <div>
          <Field
            label="Ad DM account"
            hint={cfg.agentSessionUsername ? `Empty: the agent account @${cfg.agentSessionUsername}` : 'Empty: the agent MTProto account, if one is connected'}
          >
            <div className="pp-at">
              <span aria-hidden>@</span>
              <input
                className="input-field"
                value={draft.username}
                placeholder={cfg.agentSessionUsername ?? 'ai0_ads'}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                aria-invalid={!!issueFor('adTgUsername')}
                spellCheck={false}
              />
            </div>
            {issueFor('adTgUsername') && <div className="pp-issue">{issueFor('adTgUsername')}</div>}
          </Field>

          <Field
            label="DM message"
            hint={<>
              <code>{'{target}'}</code> channel or network · <code>{'{ref}'}</code> attribution tag (added if missing)
            </>}
          >
            <textarea
              className="input-field"
              rows={3}
              value={draft.message}
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
              aria-invalid={!!issueFor('adMessage')}
              style={{ resize: 'vertical', width: '100%' }}
            />
            <div className="pp-row">
              <span className="text-micro" style={{ color: len > AD_TEMPLATE_MAX ? 'var(--color-danger)' : 'var(--color-ink-dim)' }}>
                {len}/{AD_TEMPLATE_MAX}
              </span>
              {draft.message !== cfg.defaults.adMessage && (
                <Button variant="tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setDraft({ ...draft, message: cfg.defaults.adMessage })}>
                  <Icon name="reset" size={12} /> Default text
                </Button>
              )}
            </div>
            {issueFor('adMessage') && <div className="pp-issue">{issueFor('adMessage')}</div>}
          </Field>

          <Field label="White-label offer" style={{ marginBottom: 0 }}>
            <label className="pp-check">
              <input
                type="checkbox"
                checked={draft.whiteLabelEnabled}
                onChange={(e) => setDraft({ ...draft, whiteLabelEnabled: e.target.checked })}
              />
              <span className="text-body-sm">Show the white-label section and page</span>
            </label>
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
              Off: the section is hidden and white-label requests are refused.
            </div>
          </Field>

          {dirty && (
            <div className="pp-actions">
              <Button variant="primary" disabled={!canSave} onClick={onSave}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(draftFromConfig(cfg))}>Discard</Button>
            </div>
          )}
        </div>

        <div className="pp-preview" aria-live="polite">
          <div className="pp-row" style={{ marginBottom: 8 }}>
            <span className="text-eyebrow">Live preview</span>
            {preview.data && (
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                {preview.data.username
                  ? <>opens @{preview.data.username}{preview.data.source ? ` (${SOURCE_LABEL[preview.data.source]})` : ''}</>
                  : 'no account: the page shows only the request form'}
              </span>
            )}
          </div>
          {!preview.data && <div className="la-skeleton" style={{ height: 160 }} />}
          {preview.data?.samples.map((s) => (
            <div key={s.placement + s.label} className="pp-sample" style={{ opacity: previewCurrent ? 1 : 0.6 }}>
              <div className="pp-row">
                <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{s.label}</span>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  {s.length}/{preview.data!.max}
                </span>
              </div>
              <div className="pp-bubble">{s.message}</div>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="pp-link text-micro">
                  Test link <Icon name="external" size={12} />
                </a>
              ) : (
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No link without an account</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .pp-grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); gap: var(--space-xl); align-items: start; }
        @media (max-width: 900px) { .pp-grid { grid-template-columns: 1fr; } }
        .pp-at { display: flex; align-items: center; gap: 6px; color: var(--color-ink-dim); }
        .pp-at .input-field { flex: 1; min-width: 0; }
        .pp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
        .pp-issue { margin-top: 6px; font-size: 12px; color: var(--color-danger); }
        .pp-check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--color-ink); }
        .pp-check input { width: 16px; height: 16px; cursor: pointer; }
        .pp-actions { display: flex; gap: 8px; margin-top: var(--space-lg); }
        .pp-preview { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
        .pp-sample {
          display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
          background: var(--color-surface-2); border: 1px solid var(--color-hairline);
          border-radius: var(--radius-md); transition: opacity 0.15s ease;
        }
        .pp-sample .pp-row { margin-top: 0; }
        .pp-bubble {
          white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45;
          color: var(--color-ink); background: var(--color-surface-3);
          border-radius: var(--radius-md); padding: 8px 10px; align-self: flex-start; max-width: 100%;
        }
        .pp-link { display: inline-flex; align-items: center; gap: 4px; color: var(--color-accent); text-decoration: none; align-self: flex-start; }
        .pp-link:hover { text-decoration: underline; }
      `}</style>
    </Panel>
  );
}

function StatusBadge({ cfg }: { cfg: LandingAdminConfig }): JSX.Element {
  if (cfg.resolved.username) {
    return (
      <Badge tone="success" title={`Ad buttons open a Telegram chat with @${cfg.resolved.username}`}>
        Telegram DM on
      </Badge>
    );
  }
  return (
    <Badge tone="warning" title="No Telegram account resolves: the page shows only the request form">
      Form only
    </Badge>
  );
}
