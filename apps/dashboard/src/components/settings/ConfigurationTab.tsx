// Spec 039: the Configuration tab — every setting that moved out of .env, built from the server's catalog. One panel per
// group, one row per setting: an input by type, where the value comes from (dashboard / .env / default), whether it needs
// a restart. Every change goes through a confirm showing old → new; secrets are write-only. A banner lists the settings
// waiting for a restart with the Restart service button (the page then waits for the service to come back).
// Spec 078 C4: the look (rows in flush panels, group tabs with counts) lives in settings.css, imported by the route.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  // The count on each group tab follows the search, so the tabs say where the matches are.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    if (!data) return out;
    out.set('all', filterSettings(data.settings, { query }).length);
    for (const g of data.groups) out.set(g.id, filterSettings(data.settings, { group: g.id, query }).length);
    return out;
  }, [data, query]);

  if (restartingSince) {
    return (
      <section className="panel is-section set-restart compose-rise" role="status">
        <span className="status-dot is-live" aria-hidden />
        <div>
          <h2 className="text-heading-md" style={{ margin: 0 }}>Restarting the automation service</h2>
          <p>This page reloads the settings when it is back.</p>
        </div>
      </section>
    );
  }
  if (isLoading) return <div className="panel is-section set-skeleton compose-rise" aria-hidden />;
  if (error) return <div className="callout-danger" role="alert">{errorText(error)}</div>;
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
        <p className="text-body-sm set-muted" style={{ margin: 0 }}>
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
    <div className="set-stack">
      {data.overlayError && (
        <div className="callout-danger">The database settings were not applied at start ({data.overlayError}). The service runs on the .env values.</div>
      )}
      {!data.encryptionReady && (
        <div className="callout-warning">TOKEN_ENCRYPTION_KEY is not set on the server: keys and tokens stay in .env and cannot be edited here.</div>
      )}
      {(data.pendingRestart.length > 0 || restartError) && (
        <div className="callout-warning set-banner">
          <span>
            {restartError ?? <>{data.pendingRestart.length} setting{data.pendingRestart.length === 1 ? '' : 's'} apply after a restart: {labelsOf(data, data.pendingRestart)}.</>}
            {!data.restartSupported && <> Restart the local process by hand.</>}
          </span>
          {data.restartSupported && data.pendingRestart.length > 0 && <Button variant="warning" size="sm" onClick={restart}>Restart service</Button>}
        </div>
      )}
      {save.error && <div className="callout-danger" role="alert">{errorText(save.error)}</div>}

      <div className="set-toolbar">
        <input
          type="search" className="input-field set-search" placeholder="Search settings" value={query} aria-label="Search settings"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="set-scroll">
          <SegmentedTabs size="sm" value={group} onChange={onGroup} ariaLabel="Setting groups"
            options={[{ key: 'all', label: 'All', count: counts.get('all') }, ...groups.map((g) => ({ key: g.id, label: g.label, count: counts.get(g.id) }))]} />
        </div>
      </div>

      {shown.length === 0 && <EmptyState icon="search" title="No settings match" note="Try another word or group." />}
      {shown.map((g, gi) => {
        const rows = visible.filter((s) => s.group === g.id);
        return (
          <SectionCard key={g.id} title={g.label} flush delay={Math.min(gi, 6) * 40}
            action={<span className="set-count mono">{rows.length} setting{rows.length === 1 ? '' : 's'}</span>}>
            {rows.map((s) => (
              <SettingRow key={s.key} s={s} busy={save.isPending}
                encryptionReady={data.encryptionReady} onChange={change} onReset={reset} onUseEnv={useEnv} />
            ))}
          </SectionCard>
        );
      })}
    </div>
  );
}

function labelsOf(data: SettingsCatalog, keys: string[]): string {
  return keys.map((k) => data.settings.find((s) => s.key === k)?.label ?? k).join(', ');
}

function Diff({ s, oldText, newText }: { s: SettingState; oldText: string; newText: string }) {
  return (
    <div className="set-diff">
      <code className="text-caption set-dim">{s.key}</code>
      <div className="set-diff-row">
        <span className="set-pill mono">{oldText}</span>
        <span className="set-dim">→</span>
        <span className="set-pill is-new mono">{newText}</span>
      </div>
      {s.apply === 'restart' && <span className="text-caption set-dim">Applies after a restart of the service.</span>}
      {s.danger && <span className="text-caption set-bad">{s.help}</span>}
    </div>
  );
}

function SettingRow({ s, busy, encryptionReady, onChange, onReset, onUseEnv }: {
  s: SettingState; busy: boolean; encryptionReady: boolean;
  onChange: (s: SettingState, next: string) => Promise<boolean>;
  onReset: (s: SettingState) => void;
  onUseEnv: (s: SettingState) => void;
}) {
  const src = SOURCE[s.decryptFailed ? 'env' : s.source];
  return (
    <div className="panel-row set-row">
      <div className="set-main">
        <span className="set-title">
          <span className="set-label">{s.label}</span>
          <Badge tone={src.tone} title={src.title}>{src.label}</Badge>
          {s.apply === 'restart' && !s.pendingRestart && <Badge tone="neutral" title="Read when the service starts">restart</Badge>}
          {s.pendingRestart && <Badge tone="warning" title="Changed; applies after a restart">pending restart</Badge>}
          {s.danger && <Badge tone="danger">careful</Badge>}
        </span>
        <code className="set-key mono">{s.key}</code>
        <span className="set-help">
          {s.help}{s.options && s.type === 'list' ? ` Allowed: ${s.options.join(', ')}.` : ''}
        </span>
        {s.envValue !== null && (
          <span className="set-env">
            {s.type === 'secret' ? '.env has another value; it is ignored.' : <>.env has <code className="mono">{s.envValue}</code>; it is ignored.</>}
            <Button variant="tiny" disabled={busy} onClick={() => onUseEnv(s)}>Use .env value</Button>
          </span>
        )}
        {s.decryptFailed && (
          <span className="set-note set-bad">
            The stored value cannot be decrypted (TOKEN_ENCRYPTION_KEY changed?); the .env value applies. Set it again.
          </span>
        )}
      </div>
      <div className="set-ctl">
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
      <select className="input-field set-select" value={s.value ?? ''} disabled={busy} aria-label={s.label}
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
    <span className="set-draft">
      <input
        type={numeric ? 'number' : 'text'} inputMode={numeric ? 'decimal' : undefined} className={`input-field set-input${numeric ? ' is-num' : ''}`} value={v}
        min={s.min} max={s.max} step={s.type === 'number' ? 'any' : undefined} aria-label={s.label} aria-invalid={!!err}
        placeholder={s.default ? `default: ${s.default}` : 'not set'}
        onChange={(e) => setV(e.target.value)}
      />
      {dirty && (
        <span className="set-draft-actions">
          <Button variant="primary" size="sm" disabled={busy || !!err} onClick={async () => { if (!(await onChange(s, v.trim()))) setV(server); }}>Save</Button>
          <Button variant="ghost" size="sm" onClick={() => setV(server)}>Cancel</Button>
        </span>
      )}
      {err && <span className="set-err" role="alert">{err}</span>}
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
      <span className="set-draft">
        <Badge tone={s.set ? 'success' : 'neutral'}>{s.set ? 'set' : 'not set'}</Badge>
        <Button variant="secondary" size="sm" disabled={busy || disabled} onClick={() => setOpen(true)}
          title={disabled ? 'TOKEN_ENCRYPTION_KEY is not set on the server' : undefined}>{s.set ? 'Replace' : 'Set'}</Button>
      </span>
    );
  }
  return (
    <span className="set-draft">
      <input type="password" autoComplete="off" className="input-field set-input" value={v} aria-label={s.label} placeholder="Paste the new value"
        onChange={(e) => setV(e.target.value)} />
      <span className="set-draft-actions">
        <Button variant="primary" size="sm" disabled={busy || !v.trim() || !!err} onClick={async () => { await onChange(s, v.trim()); setV(''); setOpen(false); }}>Save</Button>
        <Button variant="ghost" size="sm" onClick={() => { setV(''); setOpen(false); }}>Cancel</Button>
      </span>
      {err && <span className="set-err" role="alert">{err}</span>}
    </span>
  );
}
