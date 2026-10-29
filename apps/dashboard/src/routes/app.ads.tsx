import { createFileRoute } from '@tanstack/react-router';
import { useState, useRef } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, EmptyState, Field, StatStrip, StatTile } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { ActionsTh, RowActions, TableAction } from '../components/ui/table';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Modal } from '../components/Modal';
import { SkeletonRows } from '../components/SkeletonRows';
import {
  AD_FORMAT_LABEL, useAdOrders, useCreateAdOrder, useAdOrderCheckout, useScheduleAdOrder,
  useAdPrices, useUpsertAdPrice, useDeactivateAdPrice,
} from '../api/ads';
import { trackingApi } from '../api/tracking';
import { useQuery } from '@tanstack/react-query';
import type { AdCreative, AdFormat, AdOrder, AdPrice } from '../api/types';
import { fmtDate } from '../lib/format';
import { flagLabel, isFlagged, ORDER_STATUS_LABEL, ORDER_STATUS_TONE, summarizeOrders } from '../lib/ad-orders';
import '../components/ads/ads.css';

export const Route = createFileRoute('/app/ads')({ component: AdsPage });

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
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const channels: ChannelOpt[] = channelsQ.data?.items ?? [];
  const activePrices = (pricesQ.data ?? []).filter(p => p.active);

  const channelLabel = (id: string) => {
    const c = channels.find(x => x.id === id || x.channelKey === id);
    return c?.title ?? c?.channelKey ?? (id.startsWith('@') ? id : id.slice(0, 8));
  };

  const orders = ordersQ.data ?? [];
  const sum = summarizeOrders(orders);

  return (
    <div>
      <PageHeader
        eyebrow="Advertising"
        title="Ads"
        subtitle="Price list, ad orders, payment links, placement and advertiser reports"
        actions={
          <button type="button" className="btn-primary" onClick={() => setNewOrderOpen(true)}>
            <Icon name="plus" size={14} /> New order
          </button>
        }
      />

      {orders.length > 0 && (
        <div className="compose-rise" style={{ marginBottom: 16 }}>
          <StatStrip label="Orders by stage">
            <StatTile label="Awaiting payment" value={sum.awaitingPayment} />
            <StatTile label="Paid, to schedule" value={sum.paid} />
            <StatTile label="Scheduled" value={sum.scheduled} />
            <StatTile label="Needs attention" value={sum.flagged} deltaTone="warning"
              delta={sum.flagged > 0 ? 'flagged, see the Inbox' : undefined} />
            <StatTile label="Published" value={sum.out} />
          </StatStrip>
        </div>
      )}

      <SectionCard title="Orders" flush delay={60}
        action={orders.length > 0 ? <span className="mono text-micro" style={{ color: 'var(--color-ink-dim)' }}>{orders.length} total</span> : undefined}>
        {ordersQ.isLoading && <SkeletonRows flush rows={3} height={64} label="Loading orders" />}
        {ordersQ.error && (
          <div className="callout-danger ad-error" role="alert" style={{ margin: '0 20px 16px' }}>
            Couldn’t load the orders: {(ordersQ.error as Error).message}
          </div>
        )}
        {!ordersQ.isLoading && !ordersQ.error && orders.length === 0 && (
          <EmptyState icon="calendar" title="No ad orders yet" note="Create an order to generate a payment link for an advertiser."
            action={<button type="button" className="btn-secondary btn-sm" onClick={() => setNewOrderOpen(true)}>New order</button>} />
        )}
        {orders.map(order => (
          <OrderRow key={order.id} order={order} channelLabel={channelLabel} channels={channels} prices={pricesQ.data ?? []} />
        ))}
      </SectionCard>

      <PriceList prices={activePrices} channels={channels} />

      <NewOrder open={newOrderOpen} onClose={() => setNewOrderOpen(false)} prices={activePrices} channels={channels} />
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
    <SectionCard title="Price list" delay={120} style={{ marginTop: 16 }}
      action={prices.length > 0 ? <span className="mono text-micro" style={{ color: 'var(--color-ink-dim)' }}>{prices.length} active</span> : undefined}>
      <p className="ad-note">
        Public on the landing media kit and used for order amounts. Saving a price for the same channel and format replaces the old one (history is kept).
      </p>
      <form onSubmit={save} className="inset ad-price-form">
        <Field label="Channel">
          <select className="input-field" value={channelKey} onChange={e => setChannelKey(e.target.value)} required>
            <option value="">— pick —</option>
            {channels.filter(c => c.channelKey).map(c => (
              <option key={c.id} value={c.channelKey!}>{c.title ?? c.channelKey}</option>
            ))}
          </select>
        </Field>
        <Field label="Format">
          <select className="input-field" value={format} onChange={e => setFormat(e.target.value as AdFormat)}>
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
          <button type="submit" className="btn-secondary" disabled={upsert.isPending}>
            <Icon name="check" size={14} /> Save price
          </button>
        </div>
      </form>
      {upsert.isError && <div className="callout-danger ad-error" role="alert">{(upsert.error as Error).message}</div>}

      {prices.length === 0 ? (
        <EmptyState icon="spend" title="No active prices yet" note="Pick a channel, a format and a price above." />
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
                  <td><span className="mono">{p.channel_key}</span></td>
                  <td>
                    {AD_FORMAT_LABEL[p.format]}
                    {p.sellable === false && (
                      <Badge tone="warning" style={{ marginLeft: 6 }} title="No digest strategy runs on this channel any more (the agent runs it), so this price is hidden from the landing, the media kit and DM price lists, and new orders are refused.">
                        not offered
                      </Badge>
                    )}
                  </td>
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

// ─── New order (a drawer) ────────────────────────────────────────────────────

function NewOrder({ open, onClose, prices, channels }: { open: boolean; onClose: () => void; prices: AdPrice[]; channels: ChannelOpt[] }) {
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
          onClose();
        },
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} size="drawer" icon="plus" title="New order" subtitle="Creates the order; get its payment link from the list afterwards">
      <form id="new-ad-order" onSubmit={handleCreate}>
        <div className="ad-grid2">
          <Field label="Advertiser">
            <input className="input-field ad-fill" placeholder="Acme Corp" value={advertiser} onChange={e => setAdvertiser(e.target.value)} required />
          </Field>
          <Field label="Price" hint={price ? `${price.price_uah} UAH — amount is set by the server` : 'or enter a custom amount'}>
            <select className="input-field ad-fill" value={priceId} onChange={e => setPriceId(e.target.value)}>
              <option value="">— custom amount —</option>
              {prices.filter(p => p.sellable !== false).map(p => (
                <option key={p.id} value={p.id}>{p.channel_key} · {AD_FORMAT_LABEL[p.format]} · {p.price_uah} UAH</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="ad-grid2">
          {!priceId ? (
            <Field label="Amount (UAH)">
              <input className="input-field ad-fill" placeholder="5000.00" value={amount} onChange={e => setAmount(e.target.value)}
                pattern="^\d+(\.\d{1,2})?$" title="Decimal number, e.g. 5000.00" required />
            </Field>
          ) : <div />}
          <Field label="Channel" hint={priceId ? 'defaults to the price channel' : 'optional'}>
            <select className="input-field ad-fill" value={channelId} onChange={e => setChannelId(e.target.value)}>
              <option value="">{priceId ? '— price channel —' : '— any / TBD —'}</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
            </select>
          </Field>
        </div>
        <div className="ad-grid2">
          <Field label="Publish at" hint="agreed time (digest sponsor: the digest day)">
            <input type="datetime-local" className="input-field ad-fill" value={publishAt} onChange={e => setPublishAt(e.target.value)} />
          </Field>
          <Field label="Customer line" hint="optional — adds “Реклама. Замовник: …”">
            <input className="input-field ad-fill" placeholder="ФОП Коваль" value={sponsorLabel} onChange={e => setSponsorLabel(e.target.value)} maxLength={120} />
          </Field>
        </div>
        <Field label="Ad text" hint="optional now — Ukrainian; blank line = new paragraph; **bold**, [link](https://…). #реклама is added automatically">
          <textarea className="input-field ad-textarea" rows={4} value={text} onChange={e => setText(e.target.value)} />
        </Field>
        <div className="ad-grid3">
          <Field label="Image URL" hint="optional, makes it a photo post">
            <input className="input-field ad-fill" placeholder="https://…" value={imageUrl} onChange={e => setImageUrl(e.target.value)} />
          </Field>
          <Field label="Button label" hint="optional">
            <input className="input-field ad-fill" placeholder="Детальніше" value={buttonLabel} onChange={e => setButtonLabel(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Button URL">
            <input className="input-field ad-fill" placeholder="https://…" value={buttonUrl} onChange={e => setButtonUrl(e.target.value)} />
          </Field>
        </div>
        <Field label="Description" hint="optional, internal / invoice">
          <input className="input-field ad-fill" placeholder="Post in @channel on Mon" value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        {createMut.isError && (
          <div className="callout-danger" role="alert">{(createMut.error as Error).message}</div>
        )}
      </form>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="new-ad-order" className="btn-primary" disabled={createMut.isPending}>
          <Icon name="plus" size={14} />
          {createMut.isPending ? 'Creating…' : 'Create order'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Order row ───────────────────────────────────────────────────────────────

function OrderRow({
  order, channelLabel, channels, prices,
}: {
  order: AdOrder;
  channelLabel: (id: string) => string;
  channels: ChannelOpt[];
  prices: AdPrice[];
}) {
  const checkoutMut  = useAdOrderCheckout();
  const scheduleMut  = useScheduleAdOrder();

  const [paymentUrl,  setPaymentUrl]  = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
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
        setShowPayment(true);
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
    <>
      <div className="panel-row">
        <div className="ad-row-main">
          <div className="text-body-sm ad-row-name">{order.advertiser}</div>
          <div className="ad-row-meta">
            {order.channel_id && <span><Icon name="telegram" size={11} /> {channelLabel(order.channel_id)}</span>}
            {price && <span>{AD_FORMAT_LABEL[price.format]}</span>}
            {order.publish_at && <span><Icon name="calendar" size={11} /> {fmtDate(order.publish_at)}</span>}
          </div>
          {order.description && <div className="ad-row-desc clamp" title={order.description}>{order.description}</div>}
        </div>

        <div className="ad-row-amount mono">{order.amount} {order.currency}</div>

        <div className="ad-row-badges">
          <Badge tone={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
          {order.editor_slot_id && order.status === 'scheduled' && <Badge tone="neutral">Reserved slot</Badge>}
          {isFlagged(order) && order.flag_reason && (
            <Badge tone="danger" title={`Flagged ${order.flagged_at ? fmtDate(order.flagged_at) : ''}: see the Inbox item. Nothing is refunded or published automatically.`}>
              Needs attention: {flagLabel(order.flag_reason)}
            </Badge>
          )}
        </div>

        <div className="ad-row-actions">
          {(order.status === 'draft' || order.status === 'awaiting_payment') && (
            <button type="button" className="btn-tiny" onClick={handleCheckout} disabled={checkoutMut.isPending}>
              <Icon name="info" size={12} />
              {checkoutMut.isPending ? 'Loading…' : 'Get payment link'}
            </button>
          )}
          {paymentUrl && (
            <button type="button" className="btn-tiny" onClick={() => setShowPayment(true)}>
              <Icon name="check" size={12} /> Show payment link
            </button>
          )}
          {order.status === 'paid' && price?.format !== 'digest_sponsor' && (
            <button type="button" className="btn-tiny" onClick={() => setShowSched(true)}>
              <Icon name="calendar" size={12} /> Schedule post
            </button>
          )}
          {order.status === 'paid' && price?.format === 'digest_sponsor' && (
            <span className="ad-hint">
              {price.sellable === false
                ? 'goes out as a sponsored post on its publish day (no digest runs here)'
                : 'goes into the digest on its publish day'}
            </span>
          )}
          {order.status === 'scheduled' && (
            <span className="ad-hint">
              {order.editor_slot_id ? 'publishes automatically at its slot' : 'approve the action on /app/agent'}
            </span>
          )}
          {reportUrl && (
            <a className="btn-tiny" href={reportUrl} target="_blank" rel="noreferrer">
              <Icon name="analytics" size={12} /> Report ({order.report!.stage})
            </a>
          )}
        </div>
      </div>

      <Modal open={showPayment && !!paymentUrl} onClose={() => setShowPayment(false)} icon="info" title="Payment link"
        subtitle={`${order.advertiser} · ${order.amount} ${order.currency}`}>
        {paymentUrl && (
          <Field label="Payment link — send this to the advertiser">
            <div className="ad-link-field">
              <input ref={urlRef} readOnly autoFocus className="input-field mono" aria-label="Payment link" value={paymentUrl} onFocus={e => e.target.select()} />
              <button type="button" className="btn-tiny" onClick={() => { navigator.clipboard.writeText(paymentUrl); }}>
                <Icon name="copy" size={12} /> Copy
              </button>
            </div>
          </Field>
        )}
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={() => setShowPayment(false)}>Close</button>
        </div>
      </Modal>

      <Modal open={order.status === 'paid' && showSched} onClose={() => setShowSched(false)} icon="calendar" title="Schedule post"
        subtitle={`${order.advertiser}${price ? ` · ${AD_FORMAT_LABEL[price.format]}` : ''}`}>
        <form onSubmit={handleSchedule}>
          <div className="ad-grid2">
            <Field label="Channel">
              <select className="input-field ad-fill" value={schedChannel} onChange={e => setSchedChannel(e.target.value)} required>
                <option value="">— pick a channel —</option>
                {order.channel_id && !channels.some(c => c.id === order.channel_id) && (
                  <option value={order.channel_id}>{channelLabel(order.channel_id)}</option>
                )}
                {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
              </select>
            </Field>
            <Field label="Schedule at">
              <input type="datetime-local" className="input-field ad-fill" value={schedAt} onChange={e => setSchedAt(e.target.value)} required />
            </Field>
          </div>
          {order.creative ? (
            <p className="ad-note">
              The order’s creative is published as-is with #реклама. Approving the action on /app/agent reserves the slot.
            </p>
          ) : (
            <Field label="Post text" hint="#реклама is added automatically">
              <textarea className="input-field ad-textarea" rows={5} value={schedText} onChange={e => setSchedText(e.target.value)} required />
            </Field>
          )}
          {scheduleMut.isError && (
            <div className="callout-danger" role="alert" style={{ marginBottom: 8 }}>{(scheduleMut.error as Error).message}</div>
          )}
          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={() => setShowSched(false)}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={scheduleMut.isPending}>
              <Icon name="calendar" size={14} />
              {scheduleMut.isPending ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
