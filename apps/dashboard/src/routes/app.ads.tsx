import { createFileRoute } from '@tanstack/react-router';
import { useState, useRef } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, EmptyState, Field } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { useAdOrders, useCreateAdOrder, useAdOrderCheckout, useScheduleAdOrder } from '../api/ads';
import { trackingApi } from '../api/tracking';
import { useQuery } from '@tanstack/react-query';
import type { AdOrder, AdOrderStatus } from '../api/types';

export const Route = createFileRoute('/app/ads')({ component: AdsPage });

const STATUS_TONE: Record<AdOrderStatus, 'success' | 'accent' | 'neutral' | 'warning'> = {
  paid:             'success',
  scheduled:        'accent',
  awaiting_payment: 'neutral',
  draft:            'neutral',
  canceled:         'warning',
};

function AdsPage() {
  const [advertiser, setAdvertiser]   = useState('');
  const [channelId,  setChannelId]    = useState('');
  const [amount,     setAmount]       = useState('');
  const [description, setDescription] = useState('');

  const ordersQ    = useAdOrders();
  const createMut  = useCreateAdOrder();

  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 1, '', undefined],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }),
  });

  const channelLabel = (id: string) => {
    const c = channelsQ.data?.items.find(x => x.id === id);
    return c?.title ?? c?.channelKey ?? id.slice(0, 8);
  };

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!advertiser.trim() || !amount.trim()) return;
    createMut.mutate(
      { advertiser: advertiser.trim(), channelId: channelId || null, amount: amount.trim(), currency: 'UAH', description: description.trim() || undefined },
      {
        onSuccess: () => {
          setAdvertiser(''); setChannelId(''); setAmount(''); setDescription('');
        },
      },
    );
  }

  const orders = ordersQ.data ?? [];

  return (
    <div>
      <PageHeader title="Ads" subtitle="Ad order invoices and payment links" />

      {/* ─── Create order form ─────────────────────────────────────────────── */}
      <SectionCard title="New order" icon="plus" delay={0}>
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <Field label="Advertiser">
              <input
                className="input-field"
                placeholder="Acme Corp"
                value={advertiser}
                onChange={e => setAdvertiser(e.target.value)}
                required
              />
            </Field>
            <Field label="Amount (UAH)">
              <input
                className="input-field"
                placeholder="5000.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                pattern="^\d+(\.\d{1,2})?$"
                title="Decimal number, e.g. 5000.00"
                required
              />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <Field label="Channel" hint="optional">
              <select
                className="input-field"
                value={channelId}
                onChange={e => setChannelId(e.target.value)}
              >
                <option value="">— any / TBD —</option>
                {channelsQ.data?.items.map(c => (
                  <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Description" hint="optional">
              <input
                className="input-field"
                placeholder="Post in @channel on Mon"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </Field>
          </div>
          <div>
            <button
              type="submit"
              className="btn-primary"
              disabled={createMut.isPending}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Icon name="plus" size={14} />
              {createMut.isPending ? 'Creating…' : 'Create order'}
            </button>
            {createMut.isError && (
              <span className="text-body-sm" style={{ color: 'var(--color-danger)', marginLeft: 12 }}>
                {(createMut.error as Error).message}
              </span>
            )}
          </div>
        </form>
      </SectionCard>

      {/* ─── Orders list ──────────────────────────────────────────────────── */}
      {ordersQ.isLoading && (
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          {[0, 1, 2].map(i => (
            <div key={i} className="card compose-rise" style={{ height: 78, opacity: 0.55, animationDelay: `${i * 60}ms`, background: 'var(--color-surface-1)' }} />
          ))}
        </div>
      )}

      {!ordersQ.isLoading && orders.length === 0 && (
        <EmptyState icon="calendar" title="No ad orders yet" note="Create an order above to generate a payment link for an advertiser." />
      )}

      {orders.length > 0 && (
        <SectionCard title="Orders" icon="calendar" delay={60}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orders.map((order, i) => (
              <OrderRow key={order.id} order={order} index={i} channelLabel={channelLabel} channelsQ={channelsQ.data?.items ?? []} />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function OrderRow({
  order, index, channelLabel, channelsQ,
}: {
  order: AdOrder;
  index: number;
  channelLabel: (id: string) => string;
  channelsQ: Array<{ id: string; title: string | null; channelKey?: string | null }>;
}) {
  const checkoutMut  = useAdOrderCheckout();
  const scheduleMut  = useScheduleAdOrder();

  const [paymentUrl,  setPaymentUrl]  = useState<string | null>(null);
  const [showSched,   setShowSched]   = useState(false);
  const [schedChannel, setSchedChannel] = useState('');
  const [schedText,   setSchedText]   = useState('');
  const [schedAt,     setSchedAt]     = useState('');
  const [schedDone,   setSchedDone]   = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  function handleCheckout() {
    checkoutMut.mutate(order.id, {
      onSuccess: ({ data, signature, actionUrl }) => {
        const url = `${actionUrl}?data=${encodeURIComponent(data)}&signature=${encodeURIComponent(signature)}`;
        setPaymentUrl(url);
        // Auto-select for easy copy
        setTimeout(() => urlRef.current?.select(), 50);
      },
    });
  }

  function handleSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!schedChannel || !schedText || !schedAt) return;
    scheduleMut.mutate(
      { id: order.id, channelId: schedChannel, text: schedText, scheduledAt: new Date(schedAt).toISOString() },
      { onSuccess: () => { setShowSched(false); setSchedDone(true); } },
    );
  }

  return (
    <div
      className="card row-lift compose-rise"
      style={{ padding: '14px 18px', animationDelay: `${index * 45}ms` }}
    >
      {/* Row: main info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        {/* Advertiser */}
        <div style={{ flex: '0 0 auto', minWidth: 140 }}>
          <div className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{order.advertiser}</div>
          {order.channel_id && (
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2 }}>
              <Icon name="telegram" size={11} /> {channelLabel(order.channel_id)}
            </div>
          )}
        </div>

        {/* Amount */}
        <div className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)', flexShrink: 0 }}>
          {order.amount} {order.currency}
        </div>

        {/* Status badge */}
        <Badge tone={STATUS_TONE[order.status]}>{order.status.replace('_', ' ')}</Badge>

        {/* Description */}
        {order.description && (
          <div className="text-body-sm" style={{ flex: 1, minWidth: 0, color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {order.description}
          </div>
        )}

        {/* Actions */}
        <div style={{ flexShrink: 0, display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          {(order.status === 'draft' || order.status === 'awaiting_payment') && (
            <button
              className="btn-tiny"
              onClick={handleCheckout}
              disabled={checkoutMut.isPending}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="info" size={12} />
              {checkoutMut.isPending ? 'Loading…' : 'Get payment link'}
            </button>
          )}
          {order.status === 'paid' && !showSched && !schedDone && (
            <button
              className="btn-tiny"
              onClick={() => setShowSched(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="calendar" size={12} /> Schedule post
            </button>
          )}
          {schedDone && (
            <span className="text-micro" style={{ color: 'var(--color-success)' }}>
              <Icon name="check" size={12} /> Scheduled
            </span>
          )}
        </div>
      </div>

      {/* Payment link field */}
      {paymentUrl && (
        <div style={{ marginTop: 12 }}>
          <Field label="Payment link — send this to the advertiser">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={urlRef}
                readOnly
                className="input-field"
                value={paymentUrl}
                onFocus={e => e.target.select()}
                style={{ flex: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}
              />
              <button
                className="btn-tiny"
                onClick={() => { navigator.clipboard.writeText(paymentUrl); }}
                style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Icon name="check" size={12} /> Copy
              </button>
            </div>
          </Field>
        </div>
      )}

      {/* Schedule post form — shown only when paid + user clicked button */}
      {order.status === 'paid' && showSched && (
        <form onSubmit={handleSchedule} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <Field label="Channel">
              <select className="input-field" value={schedChannel} onChange={e => setSchedChannel(e.target.value)} required>
                <option value="">— pick a channel —</option>
                {channelsQ.map(c => (
                  <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Schedule at">
              <input
                type="datetime-local"
                className="input-field"
                value={schedAt}
                onChange={e => setSchedAt(e.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="Post text">
            <textarea
              className="input-field"
              rows={3}
              value={schedText}
              onChange={e => setSchedText(e.target.value)}
              required
              style={{ resize: 'vertical' }}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn-primary" disabled={scheduleMut.isPending} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="calendar" size={14} />
              {scheduleMut.isPending ? 'Scheduling…' : 'Schedule'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowSched(false)}>
              Cancel
            </button>
            {scheduleMut.isError && (
              <span className="text-body-sm" style={{ color: 'var(--color-danger)' }}>
                {(scheduleMut.error as Error).message}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
