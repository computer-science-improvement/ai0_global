// apps/automation/src/config/landing-leads.service.ts
// Spec 026 FR-011 / FR-015: lead intake from the public forms, and the owner's Leads tab.
//
// POST /api/landing/leads, in this order:
//   1. 5 submissions an hour per client (salted IP hash, in memory)   → 429
//   2. kind 'white_label' while the white-label flag is off          → 403
//   3. validation (landing-leads.ts)                                  → 400 {issues}
//   4. honeypot filled or the form sent too fast: stored as `spam`, no alert → 201
//   5. same client + contact + kind within 24 h: the row is updated, no alert → 201
//   6. a new lead: stored, then one OwnerInbox item + admin-bot alert, at most
//      DAILY_ALERT_CAP a day (leads past the cap are still stored)        → 201
//   The DB down → 503 with the Telegram DM link (if one exists) as the way out.
//
// Personal data: name and contact live only in landing_leads (owner-only routes; the
// agents' editor_ro role has no grant, 066 revokes it). The IP itself is never
// stored: `ip_hash = sha256(salt + ip)` serves dedup. The agent_inbox item has no
// name or contact; only the Telegram alert to the owner shows the contact.
import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { LandingClientGate } from './landing-client-key';
import type { LandingConfigService } from './landing-config.service';
import type { OwnerInbox } from '../editor/agents/owner-inbox';
import {
  DAILY_ALERT_CAP, LEAD_KINDS, LEAD_STATUSES, leadInboxItem, leadKindOf, parseLead,
  type LeadInput, type LeadKind, type LeadStatus,
} from './landing-leads';

type Q = Pick<Pool, 'query'>;

export interface LandingLeadsDeps {
  pool:   Q;
  gate:   Pick<LandingClientGate, 'key' | 'leadHit'>;
  config: Pick<LandingConfigService, 'publicConfig'>;
  inbox:  Pick<OwnerInbox, 'post'> | null;
  log?:   (msg: string) => void;
}

export type LeadOutcome = 'created' | 'updated' | 'spam';

/** A lead as the owner sees it (no ip_hash). */
export interface LandingLeadRow {
  id:           string;
  kind:         LeadKind;
  status:       LeadStatus;
  name:         string | null;
  contact:      string;
  contactKind:  string | null;
  company:      string | null;
  resources:    string[];
  platforms:    string[] | null;
  audienceSize: string | null;
  serviceMode:  string | null;
  target:       string | null;
  message:      string | null;
  placement:    string | null;
  utm:          Record<string, string> | null;
  ownerNote:    string | null;
  notifiedAt:   string | null;
  purgedAt:     string | null;
  createdAt:    string;
  updatedAt:    string;
}

const LEAD_COLUMNS = `id, kind, status, name, contact, contact_kind, company, resources, platforms, audience_size,
  service_mode, target, message, placement, utm, owner_note, notified_at, purged_at, created_at, updated_at`;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

function toRow(r: Record<string, any>): LandingLeadRow {
  return {
    id: r.id, kind: r.kind, status: r.status, name: r.name ?? null, contact: r.contact, contactKind: r.contact_kind ?? null,
    company: r.company ?? null, resources: Array.isArray(r.resources) ? r.resources : [], platforms: r.platforms ?? null,
    audienceSize: r.audience_size ?? null, serviceMode: r.service_mode ?? null, target: r.target ?? null,
    message: r.message ?? null, placement: r.placement ?? null, utm: r.utm ?? null, ownerNote: r.owner_note ?? null,
    notifiedAt: iso(r.notified_at), purgedAt: iso(r.purged_at), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OWNER_NOTE_MAX = 2000;

export class LandingLeadsService {
  constructor(private readonly d: LandingLeadsDeps) {}

  private async dmFallback(): Promise<string | null> {
    try { return (await this.d.config.publicConfig()).adDm.urls.advertise ?? null; } catch { return null; }
  }

  /** POST /api/landing/leads. Throws the HTTP error for 400/403/429/503; resolves on 201. */
  async submit(body: unknown, ip: string | null): Promise<{ ok: true; outcome: LeadOutcome }> {
    if (!this.d.gate.leadHit(ip).ok) {
      throw new HttpException({ error: 'rate_limited', message: 'Too many requests from this network. Please try again in an hour, or message us in Telegram.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (leadKindOf(body) === 'white_label') {
      let enabled: boolean;
      try { enabled = (await this.d.config.publicConfig()).whiteLabelEnabled; } catch { throw await this.unavailable(); }
      if (!enabled) throw new ForbiddenException({ error: 'white_label_disabled', message: 'White label requests are temporarily unavailable.' });
    }
    const parsed = parseLead(body);
    if (!parsed.ok) throw new BadRequestException({ error: 'invalid_lead', issues: parsed.issues });

    const ipHash = this.d.gate.key(ip);
    try {
      if (parsed.spam) {
        await this.insert(parsed.lead, ipHash, 'spam');
        return { ok: true, outcome: 'spam' };
      }
      const dup = await this.d.pool.query<{ id: string }>(
        `SELECT id FROM landing_leads
          WHERE ip_hash = $1 AND kind = $2 AND lower(contact) = lower($3) AND status <> 'spam'
            AND created_at > now() - interval '24 hours'
          ORDER BY created_at DESC LIMIT 1`, [ipHash, parsed.lead.kind, parsed.lead.contact]);
      if (dup.rows[0]) {
        await this.update(dup.rows[0].id, parsed.lead);
        return { ok: true, outcome: 'updated' };
      }
      const id = await this.insert(parsed.lead, ipHash, 'new');
      await this.notify(id, parsed.lead);
      return { ok: true, outcome: 'created' };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.d.log?.(`lead intake failed: ${(err as Error)?.message ?? err}`);
      throw await this.unavailable();
    }
  }

  private async unavailable(): Promise<ServiceUnavailableException> {
    return new ServiceUnavailableException({
      error: 'unavailable',
      message: 'Couldn’t send your request. Please message us in Telegram instead.',
      adDmUrl: await this.dmFallback(),
    });
  }

  private async insert(l: LeadInput, ipHash: string, status: 'new' | 'spam'): Promise<string> {
    const { rows } = await this.d.pool.query<{ id: string }>(
      `INSERT INTO landing_leads
         (kind, status, name, contact, contact_kind, company, resources, platforms, audience_size, service_mode,
          target, message, lang, placement, utm, ip_hash, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'en',$13,$14::jsonb,$15, now())
       RETURNING id`,
      [l.kind, status, l.name, l.contact, l.contactKind, l.company, JSON.stringify(l.resources), l.platforms,
       l.audienceSize, l.serviceMode, l.target, l.message, l.placement, l.utm ? JSON.stringify(l.utm) : null, ipHash]);
    return rows[0].id;
  }

  /** A repeat within 24 h refreshes the request (latest wording wins) without a new alert or a status change. */
  private async update(id: string, l: LeadInput): Promise<void> {
    await this.d.pool.query(
      `UPDATE landing_leads SET
         name = COALESCE($2, name), contact = $3, contact_kind = $4, company = COALESCE($5, company),
         resources = CASE WHEN jsonb_array_length($6::jsonb) > 0 THEN $6::jsonb ELSE resources END,
         platforms = COALESCE($7, platforms), audience_size = COALESCE($8, audience_size),
         service_mode = COALESCE($9, service_mode), target = COALESCE($10, target),
         message = COALESCE($11, message), placement = COALESCE($12, placement), utm = COALESCE($13::jsonb, utm),
         consent_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, l.name, l.contact, l.contactKind, l.company, JSON.stringify(l.resources), l.platforms, l.audienceSize,
       l.serviceMode, l.target, l.message, l.placement, l.utm ? JSON.stringify(l.utm) : null]);
  }

  /** One inbox item + admin-bot alert, unless today's cap is spent. Never fails the submit. */
  private async notify(id: string, l: LeadInput): Promise<void> {
    if (!this.d.inbox) return;
    try {
      const { rows } = await this.d.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM landing_leads WHERE notified_at >= date_trunc('day', now())`);
      if (Number(rows[0]?.n ?? 0) >= DAILY_ALERT_CAP) return;
      const item = leadInboxItem(id, l);
      await this.d.inbox.post({
        kind: 'landing_lead', severity: 'action', refType: 'landing_lead', refId: id,
        title: item.title, body: item.body, alert: item.alert,
      });
      await this.d.pool.query(`UPDATE landing_leads SET notified_at = now() WHERE id = $1`, [id]);
    } catch (err) {
      this.d.log?.(`lead alert failed for ${id}: ${(err as Error)?.message ?? err}`);
    }
  }

  // ── owner side (guarded routes) ─────────────────────────────────────────

  /** GET /api/landing/admin/leads?kind=&status=&limit= — newest first; spam only when asked for. */
  async list(q: { kind?: unknown; status?: unknown; limit?: unknown } = {}): Promise<LandingLeadRow[]> {
    const kind = (LEAD_KINDS as readonly unknown[]).includes(q.kind) ? (q.kind as LeadKind) : null;
    const status = (LEAD_STATUSES as readonly unknown[]).includes(q.status) ? (q.status as LeadStatus) : null;
    const n = Number(q.limit);
    const limit = Number.isInteger(n) && n >= 1 && n <= 500 ? n : 200;
    const { rows } = await this.d.pool.query(
      `SELECT ${LEAD_COLUMNS} FROM landing_leads
        WHERE ($1::text IS NULL OR kind = $1)
          AND (CASE WHEN $2::text IS NULL THEN status <> 'spam' ELSE status = $2 END)
        ORDER BY (status = 'new') DESC, created_at DESC
        LIMIT $3`, [kind, status, limit]);
    return rows.map(toRow);
  }

  /** PATCH /api/landing/admin/leads/:id `{status?, ownerNote?}`; null = not found. */
  async patch(id: string, body: unknown): Promise<LandingLeadRow | null> {
    if (!UUID_RE.test(id)) return null;
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const issues: Array<{ path: string; message: string }> = [];
    if (b.status !== undefined && !(LEAD_STATUSES as readonly unknown[]).includes(b.status)) {
      issues.push({ path: 'status', message: `status must be one of ${LEAD_STATUSES.join(', ')}` });
    }
    if (b.ownerNote !== undefined && b.ownerNote !== null && (typeof b.ownerNote !== 'string' || b.ownerNote.length > OWNER_NOTE_MAX)) {
      issues.push({ path: 'ownerNote', message: `the note must be text of at most ${OWNER_NOTE_MAX} characters` });
    }
    if (b.status === undefined && b.ownerNote === undefined) issues.push({ path: 'form', message: 'nothing to change' });
    if (issues.length) throw new BadRequestException({ error: 'invalid_lead_patch', issues });
    const note = b.ownerNote === undefined ? undefined : (typeof b.ownerNote === 'string' && b.ownerNote.trim() ? b.ownerNote.trim() : null);
    const { rows } = await this.d.pool.query(
      `UPDATE landing_leads SET
         status = COALESCE($2, status),
         owner_note = CASE WHEN $3::bool THEN $4 ELSE owner_note END,
         updated_at = now()
       WHERE id = $1
       RETURNING ${LEAD_COLUMNS}`,
      [id, (b.status as string | undefined) ?? null, note !== undefined, note ?? null]);
    return rows[0] ? toRow(rows[0]) : null;
  }
}
