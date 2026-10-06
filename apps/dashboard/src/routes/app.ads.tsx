import { createFileRoute } from '@tanstack/react-router';
import { useState, useRef } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, EmptyState, Field } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { ActionsTh, RowActions, TableAction } from '../components/ui/table';
import { useConfirm } from '../components/ui/ConfirmDialog';
import {
  AD_FORMAT_LABEL, useAdOrders, useCreateAdOrder, useAdOrderCheckout, useScheduleAdOrder,
  useAdPrices, useUpsertAdPrice, useDeactivateAdPrice,
} from '../api/ads';
import { trackingApi } from '../api/tracking';
import { useQuery } from '@tanstack/react-query';
import type { AdCreative, AdFormat, AdOrder, AdOrderStatus, AdPrice } from '../api/types';
import { fmtDate } from '../lib/format';

export const Route = createFileRoute('/app/ads')({ component: AdsPage });

const STATUS_TONE: Record<AdOrderStatus, 'success' | 'accent' | 'neutral' | 'warning'> = {
  paid:             'success',
  scheduled:        'accent',
  published:        'success',
  reported:         'accent',
  awaiting_payment: 'neutral',
  draft:            'neutral',
  canceled:         'warning',
};

const FORMATS: AdFormat[] = ['post', 'pin_24h', 'digest_sponsor'];

type ChannelOpt = { id: string; title: string | null; channelKey?: string | null };

/** Paragraphs separated by a blank line → creative blocks; an image URL makes it a photo post. */
function buildCreative(text: string, imageUrl: string, buttonLabel: string, buttonUrl: string): AdCreative | undefined {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paras.length) return undefined;
  return {
    format: imageUrl.trim() ? 'photo' : 'text',
    body:   paras.map(p => ({ type: 'p' as const, text: p })),
    ...(imageUrl.trim() ? { media: [{ url: imageUrl.trim() }] } : {}),
    ...(buttonLabel.trim() && buttonUrl.trim() ? { cta: { label: buttonLabel.trim(), url: buttonUrl.trim() } } : {}),
  };
}

function localInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AdsPage() {
  const ordersQ = useAdOrders();
  const pricesQ = useAdPrices();
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 1, '', undefined],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }),
  });
  const channels: ChannelOpt[] = channelsQ.data?.items ?? [];
  const activePrices = (pricesQ.data ?? []).filter(p => p.active);

  const channelLabel = (id: string) => {
    const c = channels.find(x => x.id === id || x.channelKey === id);
    return c?.title ?? c?.channelKey ?? (id.startsWith('@') ? id : id.slice(0, 8));
  };

  const orders = ordersQ.data ?? [];

  return (
    <div>
      <PageHeader title="Ads" subtitle="Price list, ad orders, payment links, placement and advertiser reports" />

      <PriceList prices={activePrices} channels={channels} />

      <NewOrder prices={activePrices} channels={channels} />

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
        <SectionCard title="Orders" icon="calendar" delay={120}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orders.map((order, i) => (
              <OrderRow key={order.id} order={order} index={i} channelLabel={channelLabel} channels={channels} prices={pricesQ.data ?? []} />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── Price list ──────────────────────────────────────────────────────────────

function PriceList({ prices, channels }: { prices: AdPrice[]; channels: ChannelOpt[] }) {
  const upsert = useUpsertAdPrice();
  const deactivate = useDeactivateAdPrice();
  const confirm = useConfirm();
  const [channelKey, setChannelKey] = useState('');
  const [format, setFormat] = useState<AdFormat>('post');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  function save(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(price);
    if (!channelKey || !Number.isInteger(n) || n < 1) return;
    upsert.mutate({ channelKey, format, priceUah: n, note: note.trim() || undefined }, {
      onSuccess: () => { setPrice(''); setNote(''); },
    });
  }

  return (
    <SectionCard title="Price list" icon="analytics" delay={0}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 0 }}>
        Public on the landing media kit and used for order amounts. Saving a price for the same channel and format replaces the old one (history is kept).
      </p>
      <form onSubmit={save} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0 16px', alignItems: 'end' }}>
        <Field label="Channel">
          <select className="input-field" style={{ width: '100%' }} value={channelKey} onChange={e => setChannelKey(e.target.value)} required>
            <option value="">— pick —</option>
            {channels.filter(c => c.channelKey).map(c => (
              <option key={c.id} value={c.channelKey!}>{c.title ?? c.channelKey}</option>
            ))}
          </select>
        </Field>
        <Field label="Format">
          <select className="input-field" style={{ width: '100%' }} value={format} onChange={e => setFormat(e.target.value as AdFormat)}>
            {FORMATS.map(f => <option key={f} value={f}>{AD_FORMAT_LABEL[f]}</option>)}
          </select>
        </Field>
        <Field label="Price (UAH)">
          <input className="input-field" inputMode="numeric" pattern="^\d+$" placeholder="1500" value={price} onChange={e => setPrice(e.target.value)} required />
        </Field>
        <Field label="Note" hint="optional, public">
          <input className="input-field" placeholder="e.g. stays in the feed" value={note} onChange={e => setNote(e.target.value)} maxLength={200} />
        </Field>
        <div style={{ marginBottom: 16 }}>
          <button type="submit" className="btn-primary" disabled={upsert.isPending} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> Save
          </button>
        </div>
      </form>
      {upsert.isError && <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginTop: 0 }}>{(upsert.error as Error).message}</p>}

      {prices.length === 0 ? (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No active prices yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>Channel</th>
              <th>Format</th>
              <th className="num">Price, UAH</th>
              <th>Note</th>
              <ActionsTh />
            </tr></thead>
            <tbody>
              {prices.map(p => (
                <tr key={p.id}>
                  <td>{p.channel_key}</td>
                  <td>{AD_FORMAT_LABEL[p.format]}</td>
                  <td className="num">{p.price_uah.toLocaleString('en-GB')}</td>
                  <td style={{ color: 'var(--color-ink-muted)' }}>{p.note ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <RowActions danger={
                      <TableAction action="delete" title="Deactivate" onClick={async () => {
                        if (await confirm(`deactivate the ${AD_FORMAT_LABEL[p.format]} price of ${p.channel_key}`)) deactivate.mutate(p.id);
                      }} />
                    } />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ─── New order ───────────────────────────────────────────────────────────────

function NewOrder({ prices, channels }: { prices: AdPrice[]; channels: ChannelOpt[] }) {
  const createMut = useCreateAdOrder();
  const [advertiser, setAdvertiser] = useState('');
  const [priceId, setPriceId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [publishAt, setPublishAt] = useState('');
  const [sponsorLabel, setSponsorLabel] = useState('');
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [buttonLabel, setButtonLabel] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');

  const price = prices.find(p => p.id === priceId);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!advertiser.trim() || (!priceId && !amount.trim())) return;
    createMut.mutate(
      {
        advertiser: advertiser.trim(),
        channelId: channelId || null,
        amount: amount.trim(),
        currency: 'UAH',
        description: description.trim() || undefined,
        priceId: priceId || undefined,
        publishAt: publishAt ? new Date(publishAt).toISOString() : undefined,
        sponsorLabel: sponsorLabel.trim() || undefined,
        creative: buildCreative(text, imageUrl, buttonLabel, buttonUrl),
      },
      {
        onSuccess: () => {
          setAdvertiser(''); setPriceId(''); setChannelId(''); setAmount(''); setDescription('');
          setPublishAt(''); setSponsorLabel(''); setText(''); setImageUrl(''); setButtonLabel(''); setButtonUrl('');
        },
      },
    );
  }

  const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 24px' } as const;

  return (
    <SectionCard title="New order" icon="plus" delay={60}>
      <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={grid2}>
          <Field label="Advertiser">
            <input className="input-field" placeholder="Acme Corp" value={advertiser} onChange={e => setAdvertiser(e.target.value)} required />
          </Field>
          <Field label="Price" hint={price ? `${price.price_uah} UAH — amount is set by the server` : 'or enter a custom amount'}>
            <select className="input-field" value={priceId} onChange={e => setPriceId(e.target.value)}>
              <option value="">— custom amount —</option>
              {prices.map(p => (
                <option key={p.id} value={p.id}>{p.channel_key} · {AD_FORMAT_LABEL[p.format]} · {p.price_uah} UAH</option>
              ))}
            </select>
          </Field>
        </div>
        <div style={grid2}>
          {!priceId ? (
            <Field label="Amount (UAH)">
              <input className="input-field" placeholder="5000.00" value={amount} onChange={e => setAmount(e.target.value)}
                pattern="^\d+(\.\d{1,2})?$" title="Decimal number, e.g. 5000.00" required />
            </Field>
          ) : <div />}
          <Field label="Channel" hint={priceId ? 'defaults to the price channel' : 'optional'}>
            <select className="input-field" value={channelId} onChange={e => setChannelId(e.target.value)}>
              <option value="">{priceId ? '— price channel —' : '— any / TBD —'}</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
            </select>
          </Field>
        </div>
        <div style={grid2}>
          <Field label="Publish at" hint="agreed time (digest sponsor: the digest day)">
            <input type="datetime-local" className="input-field" value={publishAt} onChange={e => setPublishAt(e.target.value)} />
          </Field>
          <Field label="Customer line" hint="optional — adds “Реклама. Замовник: …”">
            <input className="input-field" placeholder="ФОП Коваль" value={sponsorLabel} onChange={e => setSponsorLabel(e.target.value)} maxLength={120} />
          </Field>
        </div>
        <Field label="Ad text" hint="optional now — Ukrainian; blank line = new paragraph; **bold**, [link](https://…). #реклама is added automatically">
          <textarea className="input-field" rows={4} value={text} onChange={e => setText(e.target.value)} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 24px' }}>
          <Field label="Image URL" hint="optional, makes it a photo post">
            <input className="input-field" placeholder="https://…" value={imageUrl} onChange={e => setImageUrl(e.target.value)} />
          </Field>
          <Field label="Button label" hint="optional">
            <input className="input-field" placeholder="Детальніше" value={buttonLabel} onChange={e => setButtonLabel(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Button URL">
            <input className="input-field" placeholder="https://…" value={buttonUrl} onChange={e => setButtonUrl(e.target.value)} />
          </Field>
        </div>
        <Field label="Description" hint="optional, internal / invoice">
          <input className="input-field" placeholder="Post in @channel on Mon" value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <div>
          <button type="submit" className="btn-primary" disabled={createMut.isPending} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
  );
}

// ─── Order row ───────────────────────────────────────────────────────────────

function OrderRow({
  order, index, channelLabel, channels, prices,
}: {
  order: AdOrder;
  index: number;
  channelLabel: (id: string) => string;
  channels: ChannelOpt[];
  prices: AdPrice[];
}) {
  const checkoutMut  = useAdOrderCheckout();
  const scheduleMut  = useScheduleAdOrder();

  const [paymentUrl,  setPaymentUrl]  = useState<string | null>(null);
  const [showSched,   setShowSched]   = useState(false);
  const [schedChannel, setSchedChannel] = useState(order.channel_id ?? '');
  const [schedText,   setSchedText]   = useState('');
  const [schedAt,     setSchedAt]     = useState(localInput(order.publish_at));
  const urlRef = useRef<HTMLInputElement>(null);

  const price = prices.find(p => p.id === order.price_id);
  const reportUrl = order.report_token && order.report ? `${window.location.origin}/report/${order.report_token}` : null;

  function handleCheckout() {
    checkoutMut.mutate(order.id, {
      onSuccess: ({ data, signature, actionUrl }) => {
        const url = `${actionUrl}?data=${encodeURIComponent(data)}&signature=${encodeURIComponent(signature)}`;
        setPaymentUrl(url);
        setTimeout(() => urlRef.current?.select(), 50);
      },
    });
  }

  function handleSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!schedChannel || !schedAt || (!order.creative && !schedText.trim())) return;
    scheduleMut.mutate(
      { id: order.id, channelId: schedChannel, text: schedText || undefined, scheduledAt: new Date(schedAt).toISOString() },
      { onSuccess: () => setShowSched(false) },
    );
  }

  return (
    <div className="card row-lift compose-rise" style={{ padding: '14px 18px', animationDelay: `${index * 45}ms` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 auto', minWidth: 140 }}>
          <div className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{order.advertiser}</div>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {order.channel_id && <span><Icon name="telegram" size={11} /> {channelLabel(order.channel_id)}</span>}
            {price && <span>{AD_FORMAT_LABEL[price.format]}</span>}
            {order.publish_at && <span><Icon name="calendar" size={11} /> {fmtDate(order.publish_at)}</span>}
          </div>
        </div>

        <div className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)', flexShrink: 0 }}>
          {order.amount} {order.currency}
        </div>

        <Badge tone={STATUS_TONE[order.status]}>{order.status.replace('_', ' ')}</Badge>
        {order.editor_slot_id && order.status === 'scheduled' && <Badge tone="neutral">reserved slot</Badge>}

        {order.description && (
          <div className="text-body-sm" style={{ flex: 1, minWidth: 0, color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {order.description}
          </div>
        )}

        <div style={{ flexShrink: 0, display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          {(order.status === 'draft' || order.status === 'awaiting_payment') && (
            <button className="btn-tiny" onClick={handleCheckout} disabled={checkoutMut.isPending} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="info" size={12} />
              {checkoutMut.isPending ? 'Loading…' : 'Get payment link'}
            </button>
          )}
          {order.status === 'paid' && !showSched && price?.format !== 'digest_sponsor' && (
            <button className="btn-tiny" onClick={() => setShowSched(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="calendar" size={12} /> Schedule post
            </button>
          )}
          {order.status === 'paid' && price?.format === 'digest_sponsor' && (
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>goes into the digest on its publish day</span>
          )}
          {order.status === 'scheduled' && (
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>approve the action on /app/agent</span>
          )}
          {reportUrl && (
            <a className="btn-tiny" href={reportUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="analytics" size={12} /> Report ({order.report!.stage})
            </a>
          )}
        </div>
      </div>

      {paymentUrl && (
        <div style={{ marginTop: 12 }}>
          <Field label="Payment link — send this to the advertiser">
            <div style={{ display: 'flex', gap: 8 }}>
              <input ref={urlRef} readOnly className="input-field" value={paymentUrl} onFocus={e => e.target.select()}
                style={{ flex: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }} />
              <button className="btn-tiny" onClick={() => { navigator.clipboard.writeText(paymentUrl); }} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="check" size={12} /> Copy
              </button>
            </div>
          </Field>
        </div>
      )}

      {order.status === 'paid' && showSched && (
        <form onSubmit={handleSchedule} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 24px' }}>
            <Field label="Channel">
              <select className="input-field" value={schedChannel} onChange={e => setSchedChannel(e.target.value)} required>
                <option value="">— pick a channel —</option>
                {order.channel_id && !channels.some(c => c.id === order.channel_id) && (
                  <option value={order.channel_id}>{channelLabel(order.channel_id)}</option>
                )}
                {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
              </select>
            </Field>
            <Field label="Schedule at">
              <input type="datetime-local" className="input-field" value={schedAt} onChange={e => setSchedAt(e.target.value)} required />
            </Field>
          </div>
          {order.creative ? (
            <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 0 }}>
              The order’s creative is published as-is with #реклама. Approving the action on /app/agent reserves the slot.
            </p>
          ) : (
            <Field label="Post text" hint="#реклама is added automatically">
              <textarea className="input-field" rows={3} value={schedText} onChange={e => setSchedText(e.target.value)} required style={{ resize: 'vertical' }} />
            </Field>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn-primary" disabled={scheduleMut.isPending} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="calendar" size={14} />
              {scheduleMut.isPending ? 'Scheduling…' : 'Schedule'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowSched(false)}>Cancel</button>
            {scheduleMut.isError && (
              <span className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(scheduleMut.error as Error).message}</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
