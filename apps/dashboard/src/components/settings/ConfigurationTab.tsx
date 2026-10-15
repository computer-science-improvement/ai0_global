// Spec 039: the Configuration tab — every setting that moved out of .env, built from the server's catalog. One card per
// group, one row per setting: an input by type, where the value comes from (dashboard / .env / default), whether it needs
// a restart. Every change goes through a confirm showing old → new; secrets are write-only. A banner lists the settings
// waiting for a restart with the Restart service button (the page then waits for the service to come back).

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, type SettingState, type SettingsCatalog } from '../../api/settings';
import { SegmentedTabs } from '../SegmentedTabs';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Toggle } from '../agents/AgentsUi';
import { currentText, draftError, errorText, filterSettings, isOn, valueText } from '../../lib/settings-catalog';

const QK = ['settings', 'catalog'] as const;
const RESTART_WAIT_MS = 180_000;

const SOURCE: Record<SettingState['source'], { label: string; tone: 'accent' | 'neutral'; title: string }> = {
  db:      { label: 'dashboard', tone: 'accent',  title: 'Set on this page (stored in the database)' },
  env:     { label: '.env',      tone: 'neutral', title: 'Comes from the server environment (not moved into the database)' },
  default: { label: 'default',   tone: 'neutral', title: 'Not set: the built-in default applies' },
};

export function ConfigurationTab({ group, onGroup }: { group: string; onGroup: (g: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [restartingSince, setRestartingSince] = useState<{ bootedAt: string | null; at: number } | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: QK, queryFn: () => settingsApi.catalog(), enabled: !restartingSince });

  const put = (fresh: SettingState) => qc.setQueryData<SettingsCatalog>(QK, (old) => old && {
    ...old,
    settings: old.settings.map((x) => (x.key === fresh.key ? fresh : x)),
    pendingRestart: old.settings.map((x) => (x.key === fresh.key ? fresh : x)).filter((x) => x.pendingRestart).map((x) => x.key),
  });
  const save = useMutation({
    mutationFn: (a: { kind: 'set'; key: string; value: string } | { kind: 'reset' | 'import'; key: string }) =>
      a.kind === 'set' ? settingsApi.setValue(a.key, a.value) : a.kind === 'reset' ? settingsApi.reset(a.key) : settingsApi.importEnv(a.key),
    onSuccess: put,
  });

  // After "Restart service": poll until the service answers with a new start time.
  useEffect(() => {
    if (!restartingSince) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const fresh = await settingsApi.catalog();
        if (fresh.bootedAt && fresh.bootedAt !== restartingSince.bootedAt) {
          qc.setQueryData(QK, fresh);
          setRestartingSince(null);
          return;
        }
      } catch { /* the service is down while it restarts */ }
      if (Date.now() - restartingSince.at > RESTART_WAIT_MS) {
        setRestartError('The service did not come back within 3 minutes. Check the server logs.');
        setRestartingSince(null);
        return;
      }
      setTimeout(tick, 3000);
    };
    const first = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(first); };
  }, [restartingSince, qc]);

  const visible = useMemo(() => (data ? filterSettings(data.settings, { group: group === 'all' ? undefined : group, query }) : []), [data, group, query]);

  if (restartingSince) {
    return <div className="card" style={{ color: 'var(--color-ink-muted)' }}>Restarting the automation service… this page reloads the settings when it is back.</div>;
  }
  if (isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (error) return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{errorText(error)}</p>;
  if (!data) return null;

  const change = async (s: SettingState, next: string) => {
    const ok = await confirm(`change ${s.label}`, {
      danger: !!s.danger, confirmLabel: 'Save',
      details: <Diff s={s} oldText={currentText(s)} newText={valueText(s, next)} />,
    });
    if (ok) save.mutate({ kind: 'set', key: s.key, value: next });
    return ok;
  };
  const reset = async (s: SettingState) => {
    const ok = await confirm(`reset ${s.label}`, {
      danger: false, confirmLabel: 'Reset',
      details: <Diff s={s} oldText={currentText(s)} newText={s.type === 'secret' ? 'not set' : valueText(s, null)} />,
    });
    if (ok) save.mutate({ kind: 'reset', key: s.key });
  };
  const useEnv = async (s: SettingState) => {
    const ok = await confirm(`use the .env value of ${s.label}`, {
      danger: false, confirmLabel: 'Use .env value',
      details: <Diff s={s} oldText={currentText(s)} newText={s.type === 'secret' ? 'the .env secret' : s.envValue ?? ''} />,
    });
    if (ok) save.mutate({ kind: 'import', key: s.key });
  };
  const restart = async () => {
    setRestartError(null);
    const ok = await confirm('restart the automation service', {
      danger: true, confirmLabel: 'Restart',
      details: (
        <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          Running agent steps stop and publishing pauses for about a minute. Applies: {labelsOf(data, data.pendingRestart) || 'nothing pending'}.
        </p>
      ),
    });
    if (!ok) return;
    try {
      await settingsApi.restart();
      setRestartingSince({ bootedAt: data.bootedAt, at: Date.now() });
    } catch (e) {
      setRestartError(errorText(e));
    }
  };

  const groups = data.groups.filter((g) => data.settings.some((s) => s.group === g.id));
  const shown = groups.filter((g) => visible.some((s) => s.group === g.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.overlayError && (
        <div className="callout-danger">The database settings were not applied at start ({data.overlayError}). The service runs on the .env values.</div>
      )}
      {!data.encryptionReady && (
        <div className="callout-warning">TOKEN_ENCRYPTION_KEY is not set on the server: keys and tokens stay in .env and cannot be edited here.</div>
      )}
      {(data.pendingRestart.length > 0 || restartError) && (
        <div className="callout-warning" style={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ flex: '1 1 260px' }}>
            {restartError ?? <>{data.pendingRestart.length} setting{data.pendingRestart.length === 1 ? '' : 's'} apply after a restart: {labelsOf(data, data.pendingRestart)}.</>}
            {!data.restartSupported && <> Restart the local process by hand.</>}
          </span>
          {data.restartSupported && data.pendingRestart.length > 0 && <Button variant="primary" onClick={restart}>Restart service</Button>}
        </div>
      )}
      {save.error && <div className="callout-danger">{errorText(save.error)}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="search" className="input-field" placeholder="Search settings" value={query} aria-label="Search settings"
          onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 360, width: '100%' }}
        />
        <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
          <SegmentedTabs size="sm" value={group} onChange={onGroup} options={[{ key: 'all', label: 'All' }, ...groups.map((g) => ({ key: g.id, label: g.label }))]} />
        </div>
      </div>

      {shown.length === 0 && <EmptyState icon="search" title="No settings match" note="Try another word or group." />}
      {shown.map((g) => (
        <SectionCard key={g.id} title={g.label}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {visible.filter((s) => s.group === g.id).map((s, i, arr) => (
              <SettingRow key={s.key} s={s} last={i === arr.length - 1} busy={save.isPending}
                encryptionReady={data.encryptionReady} onChange={change} onReset={reset} onUseEnv={useEnv} />
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

function labelsOf(data: SettingsCatalog, keys: string[]): string {
  return keys.map((k) => data.settings.find((s) => s.key === k)?.label ?? k).join(', ');
}

function Diff({ s, oldText, newText }: { s: SettingState; oldText: string; newText: string }) {
  const pill = (tone: 'old' | 'new'): CSSProperties => ({
    padding: '3px 10px', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere',
    background: tone === 'old' ? 'var(--color-surface-3)' : 'var(--color-success-soft)',
    color: tone === 'old' ? 'var(--color-ink-muted)' : 'var(--color-accent)',
    border: `1px solid ${tone === 'old' ? 'var(--color-hairline)' : 'var(--color-accent)'}`,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <code className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>{s.key}</code>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={pill('old')}>{oldText}</span>
        <span style={{ color: 'var(--color-ink-dim)' }}>→</span>
        <span style={pill('new')}>{newText}</span>
      </div>
      {s.apply === 'restart' && <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>Applies after a restart of the service.</span>}
      {s.danger && <span className="text-caption" style={{ color: 'var(--color-danger)' }}>{s.help}</span>}
    </div>
  );
}

function SettingRow({ s, last, busy, encryptionReady, onChange, onReset, onUseEnv }: {
  s: SettingState; last: boolean; busy: boolean; encryptionReady: boolean;
  onChange: (s: SettingState, next: string) => Promise<boolean>;
  onReset: (s: SettingState) => void;
  onUseEnv: (s: SettingState) => void;
}) {
  const src = SOURCE[s.decryptFailed ? 'env' : s.source];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px 16px', padding: '14px 0', borderBottom: last ? 'none' : '1px solid var(--color-hairline-soft)' }}>
      <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.label}</span>
          <Badge tone={src.tone} title={src.title}>{src.label}</Badge>
          {s.apply === 'restart' && !s.pendingRestart && <Badge tone="neutral" title="Read when the service starts">restart</Badge>}
          {s.pendingRestart && <Badge tone="warning" title="Changed; applies after a restart">pending restart</Badge>}
          {s.danger && <Badge tone="danger">careful</Badge>}
        </span>
        <code className="text-caption" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>{s.key}</code>
        <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
          {s.help}{s.options && s.type === 'list' ? ` Allowed: ${s.options.join(', ')}.` : ''}
        </span>
        {s.envValue !== null && (
          <span className="text-caption" style={{ color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {s.type === 'secret' ? '.env has another value; it is ignored.' : <>.env has <code style={{ overflowWrap: 'anywhere' }}>{s.envValue}</code>; it is ignored.</>}
            <Button variant="tiny" disabled={busy} onClick={() => onUseEnv(s)}>Use .env value</Button>
          </span>
        )}
        {s.decryptFailed && (
          <span className="text-caption" style={{ color: 'var(--color-danger)' }}>
            The stored value cannot be decrypted (TOKEN_ENCRYPTION_KEY changed?); the .env value applies. Set it again.
          </span>
        )}
      </div>
      <div style={{ flex: '0 1 auto', maxWidth: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Control s={s} busy={busy} encryptionReady={encryptionReady} onChange={onChange} />
        {s.source === 'db' && <Button variant="tiny" disabled={busy} onClick={() => onReset(s)} title="Back to the built-in default">Reset</Button>}
      </div>
    </div>
  );
}

function Control({ s, busy, encryptionReady, onChange }: {
  s: SettingState; busy: boolean; encryptionReady: boolean; onChange: (s: SettingState, next: string) => Promise<boolean>;
}): ReactNode {
  if (s.type === 'bool') {
    const on = isOn(s, s.value ?? s.default);
    return <Toggle checked={on} disabled={busy} label={on ? 'On' : 'Off'} onChange={(v) => onChange(s, v ? (s.bool?.on ?? 'true') : (s.bool?.off ?? 'false'))} />;
  }
  if (s.type === 'enum') {
    return (
      <select className="input-field" value={s.value ?? ''} disabled={busy} aria-label={s.label} style={{ minWidth: 160, maxWidth: '100%' }}
        onChange={(e) => { if (e.target.value) void onChange(s, e.target.value); }}>
        {!s.value && <option value="">{s.default ? `default (${s.default})` : 'default'}</option>}
        {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (s.type === 'secret') return <SecretInput s={s} busy={busy} disabled={!encryptionReady} onChange={onChange} />;
  return <DraftInput s={s} busy={busy} onChange={onChange} />;
}

/** Text / number input with Save + Cancel shown only while the draft differs from the server value. */
function DraftInput({ s, busy, onChange }: { s: SettingState; busy: boolean; onChange: (s: SettingState, next: string) => Promise<boolean> }) {
  const server = s.value ?? '';
  const [v, setV] = useState(server);
  useEffect(() => { setV(server); }, [server]);
  const dirty = v.trim() !== server;
  const err = dirty ? draftError(s, v) : null;
  const numeric = s.type === 'int' || s.type === 'number';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
      <input
        type={numeric ? 'number' : 'text'} inputMode={numeric ? 'decimal' : undefined} className="input-field" value={v}
        min={s.min} max={s.max} step={s.type === 'number' ? 'any' : undefined} aria-label={s.label} aria-invalid={!!err}
        placeholder={s.default ? `default: ${s.default}` : 'not set'}
        onChange={(e) => setV(e.target.value)}
        style={{ width: numeric ? 120 : 260, maxWidth: '100%', padding: '6px 10px', fontSize: 14, textAlign: numeric ? 'right' : 'left', fontVariantNumeric: 'tabular-nums' }}
      />
      {dirty && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Button variant="primary" disabled={busy || !!err} onClick={async () => { if (!(await onChange(s, v.trim()))) setV(server); }}>Save</Button>
          <Button variant="tiny" onClick={() => setV(server)}>Cancel</Button>
        </span>
      )}
      {err && <span className="text-caption" role="alert" style={{ color: 'var(--color-danger)', width: '100%', textAlign: 'right' }}>{err}</span>}
    </span>
  );
}

/** Write-only: shows whether the secret is set; Replace opens a password input. The value is never read back. */
function SecretInput({ s, busy, disabled, onChange }: { s: SettingState; busy: boolean; disabled: boolean; onChange: (s: SettingState, next: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const err = v ? draftError(s, v) : null;
  if (!open) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Badge tone={s.set ? 'success' : 'neutral'}>{s.set ? 'set' : 'not set'}</Badge>
        <Button variant="secondary" disabled={busy || disabled} onClick={() => setOpen(true)}
          title={disabled ? 'TOKEN_ENCRYPTION_KEY is not set on the server' : undefined}>{s.set ? 'Replace' : 'Set'}</Button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
      <input type="password" autoComplete="off" className="input-field" value={v} aria-label={s.label} placeholder="Paste the new value"
        onChange={(e) => setV(e.target.value)} style={{ width: 260, maxWidth: '100%', padding: '6px 10px', fontSize: 14 }} />
      <Button variant="primary" disabled={busy || !v.trim() || !!err} onClick={async () => { await onChange(s, v.trim()); setV(''); setOpen(false); }}>Save</Button>
      <Button variant="tiny" onClick={() => { setV(''); setOpen(false); }}>Cancel</Button>
      {err && <span className="text-caption" role="alert" style={{ color: 'var(--color-danger)', width: '100%', textAlign: 'right' }}>{err}</span>}
    </span>
  );
}
