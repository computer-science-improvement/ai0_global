// Spec 026 FR-015: the Leads tab on /app/landing — requests from the public forms
// ("No Telegram?" ad requests and white-label requests). Owner-only (guarded API).
// Filter by kind and status, copy the contact, set the status and keep a note.
import { useState, type JSX } from 'react';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { SegmentedTabs } from '../SegmentedTabs';
import { Modal } from '../Modal';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useLandingLeads, usePatchLead, type LandingLead, type LeadKind, type LeadStatus } from '../../api/landing';

type KindFilter = 'all' | LeadKind;
type StatusFilter = 'open' | LeadStatus;

const KIND_TABS: ReadonlyArray<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'ad', label: 'Ad requests' }, { key: 'white_label', label: 'White label' },
];
const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'won', 'lost', 'spam'];
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost', spam: 'Spam',
};
const STATUS_TONE: Record<LeadStatus, 'accent' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  new: 'accent', contacted: 'warning', qualified: 'success', won: 'success', lost: 'neutral', spam: 'danger',
};
const AUDIENCE_LABEL: Record<string, string> = { lt_10k: '<10k', '10k_100k': '10k–100k', '100k_1m': '100k–1M', gt_1m: '>1M', unknown: 'not sure' };
const SERVICE_LABEL: Record<string, string> = { dedicated: 'Dedicated deployment', consult: 'Consultation', unsure: 'Not sure yet' };

function details(l: LandingLead): string {
  if (l.kind === 'ad') return l.target ? `Ad in ${l.target}` : 'Ad in the network';
  return [
    l.platforms?.length ? l.platforms.join(', ') : null,
    l.audienceSize ? AUDIENCE_LABEL[l.audienceSize] : null,
    l.serviceMode ? SERVICE_LABEL[l.serviceMode] : null,
  ].filter(Boolean).join(' · ') || '—';
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function LeadModal({ lead, onClose }: { lead: LandingLead; onClose: () => void }): JSX.Element {
  const patch = usePatchLead();
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [note, setNote] = useState(lead.ownerNote ?? '');
  const dirty = status !== lead.status || note !== (lead.ownerNote ?? '');
  const save = () => patch.mutate(
    { id: lead.id, patch: { status, ownerNote: note.trim() ? note : null } },
    { onSuccess: onClose },
  );
  return (
    <Modal open onClose={onClose} title={lead.kind === 'ad' ? 'Ad request' : 'White-label request'} subtitle={`Received ${fmtDate(lead.createdAt)}`} icon="inbox" size="lg">
      <div style={{ padding: 'var(--space-lg) var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <dl className="ld-dl">
          <dt>Contact</dt><dd>{lead.contact}{lead.contactKind ? ` (${lead.contactKind})` : ''}</dd>
          {lead.name && <><dt>Name</dt><dd>{lead.name}</dd></>}
          {lead.company && <><dt>Company</dt><dd>{lead.company}</dd></>}
          <dt>Request</dt><dd>{details(lead)}</dd>
          {lead.placement && <><dt>From</dt><dd>{lead.placement} button</dd></>}
          {lead.utm && <><dt>Campaign</dt><dd>{Object.entries(lead.utm).map(([k, v]) => `${k}=${v}`).join(', ')}</dd></>}
          {lead.resources.length > 0 && (
            <><dt>Resources</dt><dd>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {lead.resources.map((r) => <li key={r}><a href={r} target="_blank" rel="noopener noreferrer nofollow" className="link-accent">{r}</a></li>)}
              </ul>
            </dd></>
          )}
          {lead.message && <><dt>Message</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{lead.message}</dd></>}
          {lead.purgedAt && <><dt>Purged</dt><dd>Message and links removed by retention on {fmtDate(lead.purgedAt)}</dd></>}
        </dl>
        <label className="ld-label" htmlFor="ld-status">Status</label>
        <select id="ld-status" className="input-field" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <label className="ld-label" htmlFor="ld-note">Your note</label>
        <textarea id="ld-note" className="input-field" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'inherit', paddingTop: 8 }} />
        {patch.error && <div role="alert" className="text-body-sm" style={{ color: 'var(--color-danger)' }}>Couldn’t save: {(patch.error as Error).message}</div>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!dirty || patch.isPending} onClick={save}>
          {patch.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <style>{`
        .ld-dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; margin: 0; font-size: 14px; }
        .ld-dl dt { color: var(--color-ink-muted); }
        .ld-dl dd { margin: 0; color: var(--color-ink); overflow-wrap: anywhere; }
        .ld-label { font-size: 13px; font-weight: 600; color: var(--color-ink); margin-bottom: -8px; }
        @media (max-width: 560px) { .ld-dl { grid-template-columns: 1fr; } .ld-dl dt { margin-top: 6px; } }
      `}</style>
    </Modal>
  );
}

export function LeadsCard(): JSX.Element {
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [open, setOpen] = useState<LandingLead | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const leads = useLandingLeads({ kind: kind === 'all' ? undefined : kind, status: status === 'open' ? undefined : status });
  const patch = usePatchLead();

  return (
    <SectionCard title="Leads" icon="inbox">
      <p className="text-body-sm" style={{ margin: '0 0 12px', color: 'var(--color-ink-muted)' }}>
        Requests from the public forms: ad requests from people without Telegram, and white-label requests. Contacts are
        visible only here. Spam (the hidden form field, or a form sent in seconds) is kept under the Spam filter.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <SegmentedTabs<KindFilter> value={kind} onChange={setKind} options={KIND_TABS} size="sm" />
        <label className="text-micro" htmlFor="leads-status" style={{ color: 'var(--color-ink-muted)' }}>Status</label>
        <select id="leads-status" className="input-field" style={{ width: 'auto', minWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="open">All but spam</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>

      {leads.isLoading && <div className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>Loading…</div>}
      {leads.error && <div role="alert" className="text-body-sm" style={{ color: 'var(--color-danger)' }}>Couldn’t load leads: {(leads.error as Error).message}</div>}
      {leads.data && leads.data.length === 0 && (
        <EmptyState icon="inbox" title="No leads here" note="Requests sent from the landing forms appear here, and a new one also lands in the agents’ inbox." />
      )}
      {leads.data && leads.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Kind</th>
                <th>Who</th>
                <th>Contact</th>
                <th>Request</th>
                <th>Status</th>
                <ActionsTh />
              </tr>
            </thead>
            <tbody>
              {leads.data.map((l) => (
                <tr key={l.id}>
                  <td title={fmtDate(l.createdAt)} style={{ whiteSpace: 'nowrap' }}>{fmtRelative(l.createdAt)}</td>
                  <td><Badge tone="neutral">{l.kind === 'ad' ? 'Ad' : 'White label'}</Badge></td>
                  <td>
                    <div style={{ color: 'var(--color-ink)' }}>{l.name ?? '—'}</div>
                    {l.company && <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{l.company}</div>}
                  </td>
                  <td style={{ overflowWrap: 'anywhere' }}>
                    {l.contact}
                    {copied === l.id && <span className="text-micro" role="status" style={{ marginLeft: 6, color: 'var(--color-success)' }}>Copied</span>}
                  </td>
                  <td className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{details(l)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
                    {l.ownerNote && <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2 }} title={l.ownerNote}>Note</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <RowActions
                      danger={l.status !== 'spam'
                        ? <TableAction icon="ban" danger title="Mark as spam" disabled={patch.isPending} onClick={() => patch.mutate({ id: l.id, patch: { status: 'spam' } })} />
                        : undefined}
                    >
                      <TableAction icon="copy" title="Copy contact" onClick={async () => { if (await copy(l.contact)) { setCopied(l.id); setTimeout(() => setCopied(null), 1500); } }} />
                      <TableAction action="edit" title="Open, set status, add a note" onClick={() => setOpen(l)} />
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <LeadModal lead={open} onClose={() => setOpen(null)} />}
    </SectionCard>
  );
}
