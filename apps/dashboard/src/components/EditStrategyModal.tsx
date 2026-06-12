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
import { STRATEGY_DESCRIPTIONS, describeStrategy, SOURCE_KIND_LABEL, channelOptionLabel } from '../lib/labels';
import type { Strategy } from '../api/types';
import { SchedulePicker } from './SchedulePicker';
import { CrosspostSection } from './CrosspostSection';
import { FINITE_POOL_TYPES } from '../lib/runway';

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
  // Empty string = "use the default" (sends null on save). Number string = override.
  const [threshold, setThreshold] = useState<string>(
    strategy.low_content_threshold == null ? '' : String(strategy.low_content_threshold),
  );
  const showThreshold = FINITE_POOL_TYPES.has(strategy.type);

  useEffect(() => {
    if (open) {
      setType(strategy.type);
      setChannelId(strategy.channel_id);
      setSchedule(strategy.schedule);
      setParamsText(JSON.stringify(strategy.params ?? {}, null, 2));
      setParamsErr(null);
      setEnabled(strategy.enabled);
      setNotes(strategy.notes ?? '');
      setThreshold(strategy.low_content_threshold == null ? '' : String(strategy.low_content_threshold));
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
    if (showThreshold) {
      const next = threshold.trim() === '' ? null : Math.max(0, Math.floor(Number(threshold)));
      const current = strategy.low_content_threshold;
      if (next !== current && !(next === null && current == null)) {
        body.low_content_threshold = next;
      }
    }

    if (Object.keys(body).length === 0) { onClose(); return; }

    try {
      await patch.mutateAsync({ id: strategy.id, patch: body });
      onClose();
    } catch { /* error rendered inline */ }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit strategy" subtitle={strategy.ext_id} size="lg">
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 12 }}>
        Destination is fixed at creation. To change it, delete and recreate the strategy.
      </div>

      <Field label="Type">
        <input
          value={type}
          onChange={e => setType(e.target.value)}
          list="strategy-type-suggestions"
          className="input-field"
          style={{ width: '100%' }}
        />
        <datalist id="strategy-type-suggestions">
          {Object.keys(STRATEGY_DESCRIPTIONS).map(k => <option key={k} value={k} />)}
        </datalist>
        <TypeDescription type={type} />
      </Field>

      <Field label="Channel">
        <select
          value={channelId}
          onChange={e => setChannelId(e.target.value)}
          className="input-field"
          style={{ width: '100%' }}
        >
          {channels.data?.items.map(c => (
            <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>
          ))}
        </select>
      </Field>

      <Field label="Schedule (cron)">
        <SchedulePicker value={schedule} onChange={setSchedule} />
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

      {showThreshold && (
        <Field label="Low-content alert (posts)">
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            placeholder="100 (default)"
            className="input-field"
            style={{ width: 160 }}
            title="Warn when the remaining content for this strategy drops below this many posts. Leave empty to use the default (100)."
          />
        </Field>
      )}

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

      <CrosspostSection channelId={channelId} />

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

function TypeDescription({ type }: { type: string }) {
  const meta = describeStrategy(type.trim());
  if (!meta) return null;
  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-md)',
        borderLeft: '2px solid var(--color-accent)',
      }}
    >
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={12} />
        {meta.title}
        <span className="chip" style={{ fontSize: 10 }}>{SOURCE_KIND_LABEL[meta.source]}</span>
      </div>
      <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
        {meta.description}
      </p>
    </div>
  );
}
