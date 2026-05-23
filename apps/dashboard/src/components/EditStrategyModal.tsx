// apps/dashboard/src/components/EditStrategyModal.tsx
//
// Edits all mutable fields of a strategy binding: schedule, params, primary
// channel, enabled, notes. The PATCH endpoint accepts subsets; we send only
// fields the user touched.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { usePatchStrategy } from '../api/strategies';
import { Modal } from './Modal';
import { Icon } from './Icon';
import type { Strategy } from '../api/types';

const COMMON_SCHEDULES: Array<{ label: string; expr: string }> = [
  { label: 'Every hour (top of hour)', expr: '0 * * * *' },
  { label: 'Every 30 minutes',         expr: '*/30 * * * *' },
  { label: 'Daily at 09:00',           expr: '0 9 * * *' },
  { label: 'Daily at 18:00',           expr: '0 18 * * *' },
  { label: 'Weekdays at 09:00',        expr: '0 9 * * 1-5' },
  { label: 'Every 4 hours',            expr: '0 */4 * * *' },
];

interface Props {
  strategy: Strategy;
  open:     boolean;
  onClose:  () => void;
}

export function EditStrategyModal({ strategy, open, onClose }: Props) {
  const [type,      setType]      = useState(strategy.type);
  const [channelId, setChannelId] = useState(strategy.channel_id);
  const [schedule,  setSchedule]  = useState(strategy.schedule);
  const [paramsText, setParamsText] = useState(JSON.stringify(strategy.params ?? {}, null, 2));
  const [paramsErr,  setParamsErr]  = useState<string | null>(null);
  const [enabled,   setEnabled]   = useState(strategy.enabled);
  const [notes,     setNotes]     = useState(strategy.notes ?? '');

  useEffect(() => {
    if (open) {
      setType(strategy.type);
      setChannelId(strategy.channel_id);
      setSchedule(strategy.schedule);
      setParamsText(JSON.stringify(strategy.params ?? {}, null, 2));
      setParamsErr(null);
      setEnabled(strategy.enabled);
      setNotes(strategy.notes ?? '');
    }
  }, [open, strategy]);

  const patch = usePatchStrategy();

  const channels = useQuery({
    queryKey: ['channels', 'mine-picker'],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
    enabled:  open,
  });

  // Validate JSON live so Save isn't blocked silently.
  const tryParseParams = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(paramsText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParamsErr('params must be a JSON object');
        return null;
      }
      setParamsErr(null);
      return parsed as Record<string, unknown>;
    } catch (err: any) {
      setParamsErr(err.message);
      return null;
    }
  };

  const submit = async () => {
    const parsedParams = tryParseParams();
    if (parsedParams === null) return;

    // Only send fields that actually changed — keeps PATCH payload minimal
    // and avoids no-op writes.
    const body: Record<string, unknown> = {};
    if (type      !== strategy.type)       body.type       = type.trim();
    if (channelId !== strategy.channel_id) body.channel_id = channelId;
    if (schedule  !== strategy.schedule)   body.schedule   = schedule.trim();
    if (enabled   !== strategy.enabled)    body.enabled    = enabled;
    if (notes     !== (strategy.notes ?? '')) body.notes   = notes.trim() || null;
    if (JSON.stringify(parsedParams) !== JSON.stringify(strategy.params ?? {})) {
      body.params = parsedParams;
    }

    if (Object.keys(body).length === 0) { onClose(); return; }

    try {
      await patch.mutateAsync({ id: strategy.id, patch: body });
      onClose();
    } catch { /* error rendered inline */ }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit strategy" subtitle={strategy.ext_id} size="lg">
      <Field label="Type">
        <input value={type} onChange={e => setType(e.target.value)} className="input-field" style={{ width: '100%' }} />
      </Field>

      <Field label="Channel">
        <select
          value={channelId}
          onChange={e => setChannelId(e.target.value)}
          className="input-field"
          style={{ width: '100%' }}
        >
          {channels.data?.items.map(c => (
            <option key={c.id} value={c.id}>
              {c.title ?? c.username ?? c.id}
              {c.username ? ` (@${c.username})` : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Schedule (cron)">
        <input
          value={schedule}
          onChange={e => setSchedule(e.target.value)}
          className="input-field"
          style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {COMMON_SCHEDULES.map(s => (
            <button
              key={s.expr}
              type="button"
              onClick={() => setSchedule(s.expr)}
              className={schedule === s.expr ? 'chip is-active' : 'chip'}
              style={{ cursor: 'pointer', border: 'none' }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Params (JSON)" hint="full replacement on save">
        <textarea
          value={paramsText}
          onChange={e => { setParamsText(e.target.value); setParamsErr(null); }}
          onBlur={tryParseParams}
          className="input-field"
          style={{
            width: '100%', minHeight: 160,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12, lineHeight: 1.5, letterSpacing: 0,
          }}
        />
        {paramsErr && (
          <p className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 6 }}>{paramsErr}</p>
        )}
      </Field>

      <Field label="Notes (optional)">
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Why does this exist?"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Status">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            style={{ accentColor: 'var(--color-accent)' }}
          />
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            Enabled — cron fires this strategy
          </span>
        </label>
      </Field>

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Schedule + channel changes take effect immediately (hot-reload via config:changed). Param changes pick up on the next tick.
        </span>
      </div>

      {patch.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(patch.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={patch.isPending} className="btn-primary">
          {patch.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
