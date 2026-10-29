// Spec 026 FR-015: the Leads tab on /app/landing — requests from the public forms
// ("No Telegram?" ad requests and white-label requests). Owner-only (guarded API).
// Filter by kind and status, copy the contact, set the status and keep a note.
// Spec 078 (C6): the table sits in a SectionCard; the lead dialog's facts are an .inset.
import { useState, type JSX } from 'react';
import { SectionCard, EmptyState, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { SegmentedTabs } from '../SegmentedTabs';
import { SkeletonRows } from '../SkeletonRows';
import { Modal } from '../Modal';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useLandingLeads, usePatchLead, type LandingLead, type LeadKind, type LeadStatus } from '../../api/landing';
import type { Tone } from '../ui/primitives';
import { describeError } from '../ui/Toast';
import './landing-admin.css';

type KindFilter = 'all' | LeadKind;
type StatusFilter = 'open' | LeadStatus;

const KIND_TABS: ReadonlyArray<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'ad', label: 'Ad requests' }, { key: 'white_label', label: 'White label' },
];
const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'won', 'lost', 'spam'];
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost', spam: 'Spam',
};
// Leads are their own domain (not slots or publications), so their tones stay local to the card.
const STATUS_TONE: Record<LeadStatus, Tone> = {
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
      <div className="ld-form">
        <dl className="ld-dl inset">
          <dt>Contact</dt><dd>{lead.contact}{lead.contactKind ? ` (${lead.contactKind})` : ''}</dd>
          {lead.name && <><dt>Name</dt><dd>{lead.name}</dd></>}
          {lead.company && <><dt>Company</dt><dd>{lead.company}</dd></>}
          <dt>Request</dt><dd>{details(lead)}</dd>
          {lead.placement && <><dt>From</dt><dd>{lead.placement} button</dd></>}
          {lead.utm && <><dt>Campaign</dt><dd className="mono">{Object.entries(lead.utm).map(([k, v]) => `${k}=${v}`).join(', ')}</dd></>}
          {lead.resources.length > 0 && (
            <><dt>Resources</dt><dd>
              <ul>
                {lead.resources.map((r) => <li key={r}><a href={r} target="_blank" rel="noopener noreferrer nofollow" className="link-accent">{r}</a></li>)}
              </ul>
            </dd></>
          )}
          {lead.message && <><dt>Message</dt><dd className="ld-text">{lead.message}</dd></>}
          {lead.purgedAt && <><dt>Purged</dt><dd>Message and links removed by retention on {fmtDate(lead.purgedAt)}</dd></>}
        </dl>
        <Field label="Status">
          <select id="ld-status" aria-label="Status" className="input-field" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Your note">
          <textarea id="ld-note" aria-label="Your note" className="input-field ld-area" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {patch.error && <div role="alert" className="callout-danger ld-error">Couldn’t save: {describeError(patch.error)}</div>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!dirty || patch.isPending} onClick={save}>
          {patch.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
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
    <SectionCard title="Leads" delay={0}>
      <p className="ld-intro">
        Requests from the public forms: ad requests from people without Telegram, and white-label requests. Contacts are
        visible only here. Spam (the hidden form field, or a form sent in seconds) is kept under the Spam filter.
      </p>
      <div className="ld-toolbar">
        <SegmentedTabs<KindFilter> value={kind} onChange={setKind} options={KIND_TABS} size="sm" ariaLabel="Kind of request" />
        <label htmlFor="leads-status">Status</label>
        <select id="leads-status" className="input-field ld-status-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="open">All but spam</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>

      {leads.isLoading && <SkeletonRows rows={3} height={48} label="Loading leads" />}
      {leads.error && <div role="alert" className="callout-danger">Couldn’t load leads: {describeError(leads.error)}</div>}
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
                  <td title={fmtDate(l.createdAt)} className="ld-when">{fmtRelative(l.createdAt)}</td>
                  <td><Badge tone="neutral">{l.kind === 'ad' ? 'Ad' : 'White label'}</Badge></td>
                  <td>
                    <div className="ld-who">{l.name ?? '—'}</div>
                    {l.company && <div className="ld-sub">{l.company}</div>}
                  </td>
                  <td className="ld-contact">
                    {l.contact}
                    {copied === l.id && <span className="ld-copied" role="status">Copied</span>}
                  </td>
                  <td className="ld-detail">{details(l)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
                    {l.ownerNote && <div className="ld-note-flag" title={l.ownerNote}>Note</div>}
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
