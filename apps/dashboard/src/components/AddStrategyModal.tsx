// apps/dashboard/src/components/AddStrategyModal.tsx
//
// Compact create form for a strategy_binding. Channel is picked from the
// "Mine" set (only own channels can host strategies). Schedule is a free
// cron expression — server validates via the same `cron` lib the scheduler
// uses, so an accepted schedule is guaranteed to fire. `params` left for a
// later iteration; default `{}`.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useCreateStrategy } from '../api/strategies';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { STRATEGY_DESCRIPTIONS, describeStrategy, SOURCE_KIND_LABEL } from '../lib/labels';

const COMMON_SCHEDULES: Array<{ label: string; expr: string }> = [
  { label: 'Every hour (top of hour)',       expr: '0 * * * *' },
  { label: 'Every 30 minutes',               expr: '*/30 * * * *' },
  { label: 'Daily at 09:00',                 expr: '0 9 * * *' },
  { label: 'Daily at 18:00',                 expr: '0 18 * * *' },
  { label: 'Weekdays at 09:00',              expr: '0 9 * * 1-5' },
  { label: 'Every 4 hours',                  expr: '0 */4 * * *' },
];

interface Props { open: boolean; onClose: () => void; }

export function AddStrategyModal({ open, onClose }: Props) {
  const [extId,     setExtId]     = useState('');
  const [type,      setType]      = useState('');
  const [channelId, setChannelId] = useState('');
  const [schedule,  setSchedule]  = useState('0 9 * * *');

  const create = useCreateStrategy();

  // Mine-only channels — strategies publish, so they must be own channels.
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine-picker'],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
    enabled:  open,
  });

  const submit = async () => {
    try {
      await create.mutateAsync({
        ext_id:     extId.trim(),
        type:       type.trim(),
        channel_id: channelId,
        schedule:   schedule.trim(),
        enabled:    true,
        params:     {},
      });
      setExtId(''); setType(''); setChannelId(''); setSchedule('0 9 * * *');
      onClose();
    } catch { /* error rendered below */ }
  };

  const valid = extId && type && channelId && schedule;

  return (
    <Modal open={open} onClose={onClose} title="Add strategy" size="lg">
      <Field label="Strategy id (logical name)" hint="alphanumeric + - + _">
        <input
          value={extId}
          onChange={e => setExtId(e.target.value)}
          placeholder="motivation-quote-daily"
          className="input-field"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Type" hint="must match a registered content-strategy in automation">
        <input
          value={type}
          onChange={e => setType(e.target.value)}
          placeholder="quotes"
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
          <option value="" disabled>
            {channelsQ.isLoading ? 'Loading…' : 'Pick a channel'}
          </option>
          {channelsQ.data?.items.map(c => (
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
          placeholder="0 9 * * *"
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

      <div className="callout-warning" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span className="text-micro">
          Restart automation after creating — scheduler picks up new strategies on boot.
        </span>
      </div>

      {create.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(create.error as Error).message}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={submit} disabled={!valid || create.isPending} className="btn-primary">
          {create.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/** Inline description of the chosen strategy type. Helps the operator
 *  understand what this strategy does + which data source it draws from
 *  before saving. Renders only when the type matches a known slug. */
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
