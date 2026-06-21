// apps/automation/src/config/api/mtproto-sessions.controller.ts
//
// Manage MTProto (user-account) tracking/stats sessions from the dashboard,
// like the other connections. The session string is a secret: it is accepted on
// input, encrypted via SecretsService, and stored in session_enc. It is NEVER
// returned in any response, never logged, and the list projection deliberately
// omits session_enc. Per-session Telegram app credentials are accepted too:
// apiId (numeric, not secret — echoed back) and apiHash (encrypted into
// api_hash_enc, never returned). Both optional → env app-credential fallback.
import {
  Body, Controller, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { SecretsService } from '../../common/crypto/secrets.service';
import { MtprotoSessionsRepository, type MtprotoSessionRow } from '../mtproto-sessions.repository';
import { MtprotoVerifyClient } from '../mtproto-verify.client';
import { CreateMtprotoSessionDto, PatchMtprotoSessionDto } from './dto/mtproto-sessions.dto';

@Controller('api/mtproto-sessions')
@UseGuards(TrackingAuthGuard)
export class MtprotoSessionsController {
  constructor(
    private readonly sessions: MtprotoSessionsRepository,
    private readonly verifier: MtprotoVerifyClient,
    private readonly secrets:  SecretsService,
  ) {}

  @Get()
  async list() {
    const rows = await this.sessions.list();
    return rows.map((r) => this.toListItem(r));
  }

  /** Public projection. NEVER includes session_enc or api_hash_enc (the
   *  encrypted secrets). api_id is safe to show; has_api_creds tells the UI a
   *  per-session app secret is set (vs. relying on the env fallback). */
  private toListItem(r: MtprotoSessionRow) {
    return {
      id: r.id, label: r.label, active: r.active, role: r.role,
      username: r.username, phone: r.phone, tg_user_id: r.tg_user_id,
      api_id: r.api_id, has_api_creds: !!r.api_id && !!r.api_hash_enc,
      last_verified_at: r.last_verified_at, verify_error: r.verify_error,
      created_at: r.created_at,
    };
  }

  @Post()
  async create(@Body() body: CreateMtprotoSessionDto) {
    // Encrypt the session VALUE; never stored plaintext, logged, or echoed back.
    const sessionEnc = this.secrets.encrypt(body.session.trim());
    // The app api_hash is a secret too → encrypt it; api_id is plaintext.
    const apiHash    = body.apiHash?.trim();
    const apiHashEnc = apiHash ? this.secrets.encrypt(apiHash) : null;
    const row = await this.sessions.insert({
      label: body.label.trim(),
      session_enc: sessionEnc,
      api_id: body.apiId?.trim() || null,
      api_hash_enc: apiHashEnc,
      role: body.role,
    });
    return this.toListItem(row);
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const row = await this.sessions.findById(id);
    if (!row) throw new NotFoundException(`Session ${id} not found`);

    const session = this.secrets.maybeDecrypt(row.session_enc);
    // Use this session's own app credentials when set; the client falls back to
    // the env TELEGRAM_API_ID / TELEGRAM_API_HASH when they're omitted.
    const apiId   = row.api_id ? parseInt(row.api_id, 10) : undefined;
    const apiHash = row.api_hash_enc ? this.secrets.maybeDecrypt(row.api_hash_enc) : undefined;
    try {
      const me = await this.verifier.verify(session, {
        apiId: Number.isFinite(apiId as number) ? apiId : undefined,
        apiHash,
      });
      await this.sessions.markVerified(id, {
        username: me.username, phone: me.phone, tgUserId: me.tgUserId,
      });
      return { ok: true, username: me.username ?? undefined };
    } catch (err: any) {
      const message = String(err?.message ?? 'verification failed');
      await this.sessions.markVerifyError(id, message);
      return { ok: false, error: message };
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchMtprotoSessionDto) {
    const row = await this.sessions.findById(id);
    if (!row) throw new NotFoundException(`Session ${id} not found`);
    await this.sessions.setActive(id, body.active);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    const ok = await this.sessions.delete(id);
    if (!ok) throw new NotFoundException(`Session ${id} not found`);
  }
}
