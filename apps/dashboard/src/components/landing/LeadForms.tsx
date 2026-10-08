// Spec 026 FR-011/FR-012: the two public request forms.
//   • AdLeadForm       — "No Telegram? Leave a request" next to every ad CTA (opened in a modal);
//   • WhiteLabelForm   — the white-label request on /white-label.
// Form UX: visible labels, required fields marked, a hint where the format matters,
// inline errors on blur and on submit (linked with aria-describedby), an error summary
// that takes focus after a failed submit, a busy button while sending, and a success
// panel that takes focus. Anti-spam: a honeypot field people never see and the time
// the form was open (the server stores fast or honeypot submissions as spam).
import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type ReactNode, type RefObject } from 'react';
import { Modal } from '../Modal';
import { Icon } from '../ui/Icon';
import {
  submitLead, type AudienceSize, type LandingPlacement, type LeadPlatform, type LeadSubmission, type LeadSubmitError, type ServiceMode,
} from '../../api/landing';
import { LEAD_LIMITS, contactError, lengthError, parseResourceLinks, utmFrom } from '../../lib/lead-form';

type Errors = Record<string, string | undefined>;

// ── shared pieces ─────────────────────────────────────────────────────────────

function Field({ id, label, required, hint, error, children }: {
  id: string; label: string; required?: boolean; hint?: string; error?: string; children: ReactNode;
}): JSX.Element {
  return (
    <div className={`lf-field${error ? ' has-error' : ''}`}>
      <label htmlFor={id} className="lf-label">
        {label}
        {required ? <span className="lf-req" aria-hidden> *</span> : <span className="lf-opt"> (optional)</span>}
      </label>
      {hint && <p id={`${id}-hint`} className="lf-hint">{hint}</p>}
      {children}
      {error && <p id={`${id}-error`} className="lf-error"><Icon name="warning" size={13} /> {error}</p>}
    </div>
  );
}

/** aria-describedby for a field: its hint and its error, when present. */
const describedBy = (id: string, hint: boolean, error: string | undefined) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;

/** Visually hidden field that only bots fill. Not focusable, hidden from assistive tech. */
function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div className="lf-hp" aria-hidden="true">
      <label>
        Leave this field empty
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

function ErrorSummary({ errors, labels, refEl }: {
  errors: Errors; labels: Record<string, { id: string; label: string }>; refEl: RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  const list = Object.entries(errors).filter(([, m]) => m);
  if (!list.length) return null;
  return (
    <div className="lf-summary" role="alert" tabIndex={-1} ref={refEl}>
      <p className="lf-summary-title">Please fix {list.length === 1 ? 'this' : 'these'} before sending:</p>
      <ul>
        {list.map(([k, m]) => (
          <li key={k}>
            <a href={`#${labels[k]?.id ?? ''}`} onClick={(e) => { e.preventDefault(); document.getElementById(labels[k]?.id ?? '')?.focus(); }}>
              {labels[k]?.label ?? 'Form'}: {m}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SubmitProblem({ error }: { error: LeadSubmitError | null }): JSX.Element | null {
  if (!error || error.type === 'invalid') return null;
  return (
    <div className="lf-problem" role="alert">
      <Icon name="warning" size={15} />
      <span>
        {error.type === 'rate_limited' && 'Too many requests from your network in the last hour. Please try again later, or message us in Telegram.'}
        {error.type === 'disabled' && 'White-label requests are temporarily unavailable. Please try again later.'}
        {error.type === 'unavailable' && (
          <>
            Couldn’t send your request right now.{' '}
            {error.adDmUrl
              ? <a href={error.adDmUrl} target="_blank" rel="noopener">Message us in Telegram instead</a>
              : 'Please try again in a few minutes.'}
          </>
        )}
      </span>
    </div>
  );
}

function Success({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="lf-success" role="status">
      <span className="lf-success-icon" aria-hidden><Icon name="check" size={20} /></span>
      <h3 ref={ref} tabIndex={-1} className="lf-success-title">{title}</h3>
      <div className="lf-success-body">{children}</div>
    </div>
  );
}

function Consent({ id, checked, onChange, error }: { id: string; checked: boolean; onChange: (v: boolean) => void; error?: string }): JSX.Element {
  return (
    <div className={`lf-field${error ? ' has-error' : ''}`}>
      <label className="lf-check" htmlFor={id}>
        <input
          id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
          aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} required
        />
        <span>
          I agree that ai0 stores this request and contacts me about it. We keep it only to answer you and never share it.
          <span className="lf-req" aria-hidden> *</span>
        </span>
      </label>
      {error && <p id={`${id}-error`} className="lf-error"><Icon name="warning" size={13} /> {error}</p>}
    </div>
  );
}

const CONSENT_ERROR = 'Please agree so we can answer your request.';

function useSubmit() {
  const openedAt = useRef(Date.now());
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<LeadSubmitError | null>(null);
  const [done, setDone] = useState(false);
  const send = async (body: Omit<LeadSubmission, 'elapsedMs' | 'utm'>): Promise<LeadSubmitError | null> => {
    setPending(true);
    setProblem(null);
    const res = await submitLead({
      ...body,
      elapsedMs: Date.now() - openedAt.current,
      utm: typeof window !== 'undefined' ? utmFrom(window.location.search) : undefined,
    });
    setPending(false);
    if (res.ok) { setDone(true); return null; }
    setProblem(res.error);
    return res.error;
  };
  return { pending, problem, done, send };
}

/** Focus the error summary after the render that shows it (a failed submit). */
function useSummaryFocus(): [RefObject<HTMLDivElement | null>, () => void] {
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (tick) ref.current?.focus(); }, [tick]);
  return [ref, () => setTick((t) => t + 1)];
}

const issuesToErrors = (issues: Array<{ path: string; message: string }>): Errors =>
  Object.fromEntries(issues.map((i) => [i.path, i.message]));

// ── ad request ────────────────────────────────────────────────────────────────

export function AdLeadForm({ placement, target, dmUrl }: {
  placement: LandingPlacement; target?: string | null; dmUrl?: string | null;
}): JSX.Element {
  const uid = useId();
  const ids = { contact: `${uid}-contact`, name: `${uid}-name`, target: `${uid}-target`, message: `${uid}-message`, consent: `${uid}-consent` };
  const [v, setV] = useState({ contact: '', name: '', target: target ?? '', message: '', consent: false, website: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [summaryRef, focusSummary] = useSummaryFocus();
  const { pending, problem, done, send } = useSubmit();

  const check = (k: keyof typeof v, val = v[k]): string | undefined => {
    if (k === 'contact') return contactError(String(val)) ?? undefined;
    if (k === 'name') return lengthError(String(val), LEAD_LIMITS.name, 'The name') ?? undefined;
    if (k === 'target') return lengthError(String(val), LEAD_LIMITS.target, 'The channel') ?? undefined;
    if (k === 'message') return lengthError(String(val), LEAD_LIMITS.message, 'The message') ?? undefined;
    if (k === 'consent') return val ? undefined : CONSENT_ERROR;
    return undefined;
  };
  const blur = (k: keyof typeof v) => setErrors((e) => ({ ...e, [k]: check(k) }));
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => {
    setV((s) => ({ ...s, [k]: val }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: check(k, val) }));
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const next: Errors = {};
    for (const k of ['contact', 'name', 'target', 'message', 'consent'] as const) next[k] = check(k);
    setErrors(next);
    if (Object.values(next).some(Boolean)) { focusSummary(); return; }
    const err = await send({
      kind: 'ad', placement, contact: v.contact.trim(), name: v.name.trim() || undefined, target: v.target.trim() || undefined,
      message: v.message.trim() || undefined, consent: v.consent, website: v.website,
    });
    if (err?.type === 'invalid') { setErrors(issuesToErrors(err.issues)); focusSummary(); }
  };

  if (done) {
    return (
      <Success title="Request sent">
        <p>Thanks! We have your request{v.target.trim() ? ` for ${v.target.trim()}` : ''} and will reply to {v.contact.trim()} with prices and free slots.</p>
        <p className="lf-muted">The first reply is drafted by an AI assistant on the owner’s behalf, and the owner checks it before it is sent.</p>
      </Success>
    );
  }

  const labels = {
    contact: { id: ids.contact, label: 'How can we reach you?' }, name: { id: ids.name, label: 'Your name' },
    target: { id: ids.target, label: 'Channel' }, message: { id: ids.message, label: 'Message' }, consent: { id: ids.consent, label: 'Consent' },
  };
  return (
    <form className="lf" onSubmit={onSubmit} noValidate aria-busy={pending}>
      <ErrorSummary errors={errors} labels={labels} refEl={summaryRef} />
      <SubmitProblem error={problem} />
      <Field id={ids.contact} label={labels.contact.label} required hint="Telegram @username, email or phone." error={errors.contact}>
        <input
          id={ids.contact} className="input-field lf-input" value={v.contact} autoComplete="email" autoFocus maxLength={LEAD_LIMITS.contact + 20}
          onChange={(e) => set('contact', e.target.value)} onBlur={() => blur('contact')}
          aria-invalid={!!errors.contact} aria-describedby={describedBy(ids.contact, true, errors.contact)} required
        />
      </Field>
      <Field id={ids.name} label={labels.name.label} error={errors.name}>
        <input id={ids.name} className="input-field lf-input" value={v.name} autoComplete="name"
          onChange={(e) => set('name', e.target.value)} onBlur={() => blur('name')}
          aria-invalid={!!errors.name} aria-describedby={describedBy(ids.name, false, errors.name)} />
      </Field>
      <Field id={ids.target} label={labels.target.label} hint="Where you would like the ad. Leave empty for the whole network." error={errors.target}>
        <input id={ids.target} className="input-field lf-input" value={v.target}
          onChange={(e) => set('target', e.target.value)} onBlur={() => blur('target')}
          aria-invalid={!!errors.target} aria-describedby={describedBy(ids.target, true, errors.target)} />
      </Field>
      <Field id={ids.message} label={labels.message.label} hint="Format, dates, budget: anything that helps us answer." error={errors.message}>
        <textarea id={ids.message} className="input-field lf-input lf-textarea" rows={4} value={v.message}
          onChange={(e) => set('message', e.target.value)} onBlur={() => blur('message')}
          aria-invalid={!!errors.message} aria-describedby={describedBy(ids.message, true, errors.message)} />
      </Field>
      <Consent id={ids.consent} checked={v.consent} onChange={(c) => set('consent', c)} error={errors.consent} />
      <Honeypot value={v.website} onChange={(w) => setV((s) => ({ ...s, website: w }))} />
      <div className="lf-actions">
        <button type="submit" className="lf-btn lf-submit" disabled={pending}>
          {pending ? <><span className="lf-spinner" aria-hidden /> Sending…</> : 'Send request'}
        </button>
        {dmUrl && <a href={dmUrl} target="_blank" rel="noopener" className="lf-alt">Or message us in Telegram</a>}
      </div>
    </form>
  );
}

/** The ad request form in a modal; focus returns to the button that opened it. */
export function AdLeadModal({ open, onClose, placement, target, dmUrl }: {
  open: boolean; onClose: () => void; placement: LandingPlacement; target?: string | null; dmUrl?: string | null;
}): JSX.Element {
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (open) opener.current = document.activeElement;
    else if (opener.current instanceof HTMLElement) opener.current.focus();
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Request an ad placement" subtitle="No Telegram? Leave your contact and we will get back to you." icon="megaphone">
      <div className="lf-modal-body">
        <AdLeadForm key={`${placement}:${target ?? ''}`} placement={placement} target={target} dmUrl={dmUrl} />
      </div>
      <LeadFormStyles />
    </Modal>
  );
}

// ── white label ───────────────────────────────────────────────────────────────

const PLATFORM_OPTIONS: Array<{ key: LeadPlatform; label: string }> = [
  { key: 'telegram', label: 'Telegram' }, { key: 'instagram', label: 'Instagram' }, { key: 'facebook', label: 'Facebook' },
  { key: 'threads', label: 'Threads' }, { key: 'tiktok', label: 'TikTok' }, { key: 'youtube', label: 'YouTube' }, { key: 'other', label: 'Other' },
];
const AUDIENCE_OPTIONS: Array<{ key: AudienceSize; label: string }> = [
  { key: 'lt_10k', label: 'Under 10k' }, { key: '10k_100k', label: '10k–100k' }, { key: '100k_1m', label: '100k–1M' },
  { key: 'gt_1m', label: 'Over 1M' }, { key: 'unknown', label: 'Not sure' },
];
const SERVICE_OPTIONS: Array<{ key: ServiceMode; label: string; note: string }> = [
  { key: 'dedicated', label: 'A dedicated deployment', note: 'We set up and run the agents for your resources.' },
  { key: 'consult', label: 'A consultation', note: 'Advice on running your own network with AI agents.' },
  { key: 'unsure', label: 'Not sure yet', note: 'Let’s talk it through first.' },
];

export function WhiteLabelForm(): JSX.Element {
  const uid = useId();
  const ids = {
    name: `${uid}-name`, contact: `${uid}-contact`, company: `${uid}-company`, resources: `${uid}-resources`,
    platforms: `${uid}-platforms`, audienceSize: `${uid}-audience`, serviceMode: `${uid}-service`, message: `${uid}-message`, consent: `${uid}-consent`,
  };
  const [v, setV] = useState({
    name: '', contact: '', company: '', resources: '', platforms: [] as LeadPlatform[], audienceSize: '' as AudienceSize | '',
    serviceMode: '' as ServiceMode | '', message: '', consent: false, website: '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [summaryRef, focusSummary] = useSummaryFocus();
  const { pending, problem, done, send } = useSubmit();

  const check = (k: keyof typeof v, val: unknown = v[k]): string | undefined => {
    switch (k) {
      case 'name': return String(val).trim() ? lengthError(String(val), LEAD_LIMITS.name, 'The name') ?? undefined : 'Enter your name.';
      case 'contact': return contactError(String(val)) ?? undefined;
      case 'company': return lengthError(String(val), LEAD_LIMITS.company, 'The company') ?? undefined;
      case 'resources': return parseResourceLinks(String(val)).error ?? undefined;
      case 'message': return lengthError(String(val), LEAD_LIMITS.message, 'The message') ?? undefined;
      case 'consent': return val ? undefined : CONSENT_ERROR;
      default: return undefined;
    }
  };
  const blur = (k: keyof typeof v) => setErrors((e) => ({ ...e, [k]: check(k) }));
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => {
    setV((s) => ({ ...s, [k]: val }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: check(k, val) }));
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const next: Errors = {};
    for (const k of ['name', 'contact', 'company', 'resources', 'message', 'consent'] as const) next[k] = check(k);
    setErrors(next);
    if (Object.values(next).some(Boolean)) { focusSummary(); return; }
    const err = await send({
      kind: 'white_label', placement: 'whitelabel', name: v.name.trim(), contact: v.contact.trim(),
      company: v.company.trim() || undefined, resources: parseResourceLinks(v.resources).links,
      platforms: v.platforms.length ? v.platforms : undefined, audienceSize: v.audienceSize || undefined,
      serviceMode: v.serviceMode || undefined, message: v.message.trim() || undefined, consent: v.consent, website: v.website,
    });
    if (err?.type === 'invalid') { setErrors(issuesToErrors(err.issues)); focusSummary(); }
  };

  if (done) {
    return (
      <Success title="Thanks, your request is in">
        <p>We will reply to {v.contact.trim()} to set up a short call about your resources.</p>
        <p className="lf-muted">Nothing is set up or charged before we agree on the details.</p>
      </Success>
    );
  }

  const labels = {
    name: { id: ids.name, label: 'Your name' }, contact: { id: ids.contact, label: 'How can we reach you?' },
    company: { id: ids.company, label: 'Company or project' }, resources: { id: ids.resources, label: 'Your channels and profiles' },
    message: { id: ids.message, label: 'Anything else' }, consent: { id: ids.consent, label: 'Consent' },
  };
  const togglePlatform = (p: LeadPlatform) =>
    set('platforms', v.platforms.includes(p) ? v.platforms.filter((x) => x !== p) : [...v.platforms, p]);

  return (
    <form className="lf" onSubmit={onSubmit} noValidate aria-busy={pending}>
      <ErrorSummary errors={errors} labels={labels} refEl={summaryRef} />
      <SubmitProblem error={problem} />
      <div className="lf-row">
        <Field id={ids.name} label={labels.name.label} required error={errors.name}>
          <input id={ids.name} className="input-field lf-input" value={v.name} autoComplete="name"
            onChange={(e) => set('name', e.target.value)} onBlur={() => blur('name')}
            aria-invalid={!!errors.name} aria-describedby={describedBy(ids.name, false, errors.name)} required />
        </Field>
        <Field id={ids.contact} label={labels.contact.label} required hint="Telegram @username, email or phone." error={errors.contact}>
          <input id={ids.contact} className="input-field lf-input" value={v.contact} autoComplete="email"
            onChange={(e) => set('contact', e.target.value)} onBlur={() => blur('contact')}
            aria-invalid={!!errors.contact} aria-describedby={describedBy(ids.contact, true, errors.contact)} required />
        </Field>
      </div>
      <Field id={ids.company} label={labels.company.label} error={errors.company}>
        <input id={ids.company} className="input-field lf-input" value={v.company} autoComplete="organization"
          onChange={(e) => set('company', e.target.value)} onBlur={() => blur('company')}
          aria-invalid={!!errors.company} aria-describedby={describedBy(ids.company, false, errors.company)} />
      </Field>
      <Field id={ids.resources} label={labels.resources.label} hint="Links, one per line (up to 10), e.g. https://t.me/yourchannel." error={errors.resources}>
        <textarea id={ids.resources} className="input-field lf-input lf-textarea" rows={3} value={v.resources}
          onChange={(e) => set('resources', e.target.value)} onBlur={() => blur('resources')}
          aria-invalid={!!errors.resources} aria-describedby={describedBy(ids.resources, true, errors.resources)} />
      </Field>

      <fieldset className="lf-fieldset">
        <legend className="lf-label">Platforms you publish on <span className="lf-opt">(optional)</span></legend>
        <div className="lf-chips">
          {PLATFORM_OPTIONS.map((p) => (
            <label key={p.key} className={`lf-chip${v.platforms.includes(p.key) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={v.platforms.includes(p.key)} onChange={() => togglePlatform(p.key)} />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="lf-fieldset">
        <legend className="lf-label">Total audience <span className="lf-opt">(optional)</span></legend>
        <div className="lf-chips">
          {AUDIENCE_OPTIONS.map((a) => (
            <label key={a.key} className={`lf-chip${v.audienceSize === a.key ? ' is-on' : ''}`}>
              <input type="radio" name={ids.audienceSize} checked={v.audienceSize === a.key} onChange={() => set('audienceSize', a.key)} />
              {a.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="lf-fieldset">
        <legend className="lf-label">What would help you most? <span className="lf-opt">(optional)</span></legend>
        <div className="lf-options">
          {SERVICE_OPTIONS.map((s) => (
            <label key={s.key} className={`lf-option${v.serviceMode === s.key ? ' is-on' : ''}`}>
              <input type="radio" name={ids.serviceMode} checked={v.serviceMode === s.key} onChange={() => set('serviceMode', s.key)} />
              <span><b>{s.label}</b><span className="lf-muted">{s.note}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field id={ids.message} label={labels.message.label} hint="Your goals, how you publish today, timing." error={errors.message}>
        <textarea id={ids.message} className="input-field lf-input lf-textarea" rows={4} value={v.message}
          onChange={(e) => set('message', e.target.value)} onBlur={() => blur('message')}
          aria-invalid={!!errors.message} aria-describedby={describedBy(ids.message, true, errors.message)} />
      </Field>
      <Consent id={ids.consent} checked={v.consent} onChange={(c) => set('consent', c)} error={errors.consent} />
      <Honeypot value={v.website} onChange={(w) => setV((s) => ({ ...s, website: w }))} />
      <div className="lf-actions">
        <button type="submit" className="lf-btn lf-submit" disabled={pending}>
          {pending ? <><span className="lf-spinner" aria-hidden /> Sending…</> : 'Request a white-label setup'}
        </button>
      </div>
    </form>
  );
}

/** Scoped styles for both forms (rendered once per page that shows a form). */
export function LeadFormStyles(): JSX.Element {
  return (
    <style>{`
      .lf { display: flex; flex-direction: column; gap: var(--space-lg); text-align: left; }
      .lf-modal-body { padding: var(--space-lg) var(--space-xl) var(--space-xl); max-height: min(70vh, 720px); overflow-y: auto; }
      .lf-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); }
      @media (max-width: 640px) { .lf-row { grid-template-columns: 1fr; } .lf-modal-body { padding: var(--space-md) var(--space-lg) var(--space-lg); } }
      .lf-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .lf-label { font-size: 14px; font-weight: 600; color: var(--color-ink); padding: 0; }
      .lf-req { color: var(--color-danger); }
      .lf-opt { font-weight: 400; color: var(--color-ink-muted); }
      .lf-hint { margin: 0; font-size: 13px; color: var(--color-ink-muted); }
      .lf-input { width: 100%; font-size: 16px; min-height: 44px; }
      .lf-textarea { min-height: 96px; resize: vertical; line-height: 1.5; padding-top: 10px; padding-bottom: 10px; font-family: inherit; }
      .lf-field.has-error .lf-input { border-color: var(--color-danger); }
      .lf-error { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 13px; color: var(--color-danger); }
      .lf-error svg { flex-shrink: 0; margin-top: 2px; }
      .lf-check { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 1.5; color: var(--color-ink-muted); cursor: pointer; }
      .lf-check input { width: 20px; height: 20px; margin: 1px 0 0; flex-shrink: 0; accent-color: var(--color-accent); }
      .lf-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
      .lf-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .lf-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .lf-chip {
        position: relative; display: inline-flex; align-items: center; min-height: 40px; padding: 8px 14px;
        border-radius: var(--radius-pill); border: 1px solid var(--color-hairline-strong);
        background: var(--color-surface-2); color: var(--color-ink-muted); font-size: 14px; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      .lf-chip input, .lf-option input { position: absolute; opacity: 0; width: 1px; height: 1px; }
      .lf-chip.is-on { color: var(--color-ink); border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 14%, transparent); }
      .lf-chip:has(input:focus-visible), .lf-option:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
      .lf-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      @media (max-width: 720px) { .lf-options { grid-template-columns: 1fr; } }
      .lf-option {
        position: relative; display: flex; padding: 12px 14px; border-radius: var(--radius-md); cursor: pointer;
        border: 1px solid var(--color-hairline-strong); background: var(--color-surface-2); font-size: 14px; color: var(--color-ink);
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .lf-option > span { display: flex; flex-direction: column; gap: 2px; }
      .lf-option.is-on { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
      .lf-muted { color: var(--color-ink-muted); font-size: 13px; margin: 0; }
      .lf-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-lg); }
      .lf-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 12px 22px; border-radius: var(--radius-sm);
        background: var(--color-accent); color: var(--color-on-accent);
        font-size: 15px; font-weight: 600; letter-spacing: -0.15px; text-decoration: none;
        transition: background 0.15s ease;
      }
      .lf-btn:hover { background: var(--color-accent-deep); opacity: 1; }
      .lf-submit { border: 0; cursor: pointer; min-height: 44px; font-family: inherit; }
      .lf-submit:disabled { opacity: 0.7; cursor: progress; }
      .lf-submit:focus-visible, .lf-alt:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
      .lf-alt { color: var(--color-ink-muted); font-size: 14px; text-decoration: underline; text-underline-offset: 3px; }
      .lf-alt:hover { color: var(--color-ink); }
      .lf-spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--color-on-accent) 35%, transparent); border-top-color: var(--color-on-accent);
        animation: lf-spin 0.8s linear infinite;
      }
      @keyframes lf-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .lf-spinner { animation: none; } .lf-chip, .lf-option { transition: none; } }
      .lf-summary {
        padding: 12px 14px; border-radius: var(--radius-md);
        border: 1px solid color-mix(in srgb, var(--color-danger) 45%, transparent); background: var(--color-danger-soft);
        color: var(--color-ink); font-size: 14px;
      }
      .lf-summary:focus { outline: 2px solid var(--color-danger); outline-offset: 2px; }
      .lf-summary-title { margin: 0 0 6px; font-weight: 600; }
      .lf-summary ul { margin: 0; padding-left: 18px; }
      .lf-summary a { color: var(--color-ink); text-decoration: underline; }
      .lf-problem {
        display: flex; gap: 8px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius-md);
        background: var(--color-warning-soft); color: var(--color-ink); font-size: 14px; line-height: 1.5;
      }
      .lf-problem svg { flex-shrink: 0; margin-top: 3px; color: var(--color-warning); }
      .lf-problem a { color: var(--color-ink); text-decoration: underline; font-weight: 600; }
      .lf-success { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-sm); padding: var(--space-lg) 0; text-align: left; }
      .lf-success-icon {
        display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%;
        background: var(--color-success-soft); color: var(--color-success);
      }
      .lf-success-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--color-ink); }
      .lf-success-title:focus { outline: none; }
      .lf-success-body { display: flex; flex-direction: column; gap: 6px; font-size: 15px; line-height: 1.55; color: var(--color-ink-muted); }
      .lf-success-body p { margin: 0; }
    `}</style>
  );
}
