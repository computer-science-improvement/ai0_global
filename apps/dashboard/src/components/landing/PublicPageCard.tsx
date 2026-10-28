// Spec 026 FR-002/FR-003/FR-015: the "Public page" card on /app/landing. The owner
// edits the Telegram account that takes ad DMs, the prefilled DM text and the
// white-label switch; the right side previews the exact messages and links the
// public page will use. The preview is rendered by the server (the same builder the
// public page uses), from the unsaved draft, debounced.
// Spec 078 (C6): a padded SectionCard; each sample message is an .inset.

import { useEffect, useState, type JSX } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field, SectionCard } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { SkeletonRows } from '../SkeletonRows';
import {
  useLandingAdminConfig, useLandingDmPreview, useSaveLandingConfig,
  type LandingAdminConfig, type LandingConfigIssue,
} from '../../api/landing';
import {
  AD_TEMPLATE_MAX, charCount, configPatch, draftFromConfig, previewDraft, type LandingConfigDraft,
} from '../../lib/landing-config-draft';
import './landing-admin.css';

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
    return <SectionCard title="Public page" delay={0}><SkeletonRows rows={1} height={120} label="Loading the public page settings" /></SectionCard>;
  }
  if (error || !cfg || !draft) {
    return (
      <SectionCard title="Public page" delay={0}>
        <div className="callout-danger" role="alert">
          Couldn’t load the public page settings{error ? `: ${(error as Error).message}` : ''}
        </div>
      </SectionCard>
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
    <SectionCard title="Public page" delay={0} action={<StatusBadge cfg={cfg} />}>
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
              className="input-field pp-area"
              rows={3}
              value={draft.message}
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
              aria-invalid={!!issueFor('adMessage')}
            />
            <div className="pp-row">
              <span className={`pp-len${len > AD_TEMPLATE_MAX ? ' is-over' : ''}`}>
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
            <div className="pp-help">
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
          <div className="pp-row is-head">
            <span className="text-eyebrow">Live preview</span>
            {preview.data && (
              <span className="pp-source">
                {preview.data.username
                  ? <>opens <span className="mono">@{preview.data.username}</span>{preview.data.source ? ` (${SOURCE_LABEL[preview.data.source]})` : ''}</>
                  : 'no account: the page shows only the request form'}
              </span>
            )}
          </div>
          {!preview.data && <SkeletonRows rows={1} height={160} label="Loading the preview" />}
          {preview.data?.samples.map((s) => (
            <div key={s.placement + s.label} className="inset pp-sample" style={{ opacity: previewCurrent ? 1 : 0.6 }}>
              <div className="pp-row">
                <span className="pp-sample-label">{s.label}</span>
                <span className="pp-sample-len">
                  {s.length}/{preview.data!.max}
                </span>
              </div>
              <div className="pp-bubble">{s.message}</div>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="pp-link">
                  Test link <Icon name="external" size={12} />
                </a>
              ) : (
                <span className="pp-none">No link without an account</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
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
