// MTProto sessions — the user accounts the tracker logs in as to read
// channel stats / competitor feeds. Plural-ready (multi-session is on the
// roadmap); today it lists the one .env-configured tracking session. Shows
// the real Telegram account behind each session (username / name / phone)
// when connected. Read-only — session strings live in .env, never shown.

import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../../api/tracking';
import { Icon } from '../Icon';
import type { TrackingSession } from '../../api/types';

export function SessionsPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tracking-sessions'],
    queryFn:  () => trackingApi.sessionStatus(),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 className="text-eyebrow" style={{ margin: 0 }}>MTProto-сесії</h2>
        <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
          Користувацькі акаунти, якими трекер збирає статистику й відстежує канали.
          Рядки сесій зберігаються у <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
        </p>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.sessions.map((s) => <SessionCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  );
}

function SessionCard({ s }: { s: TrackingSession }) {
  const state: 'ok' | 'configured-not-ready' | 'empty' =
    s.ready ? 'ok' : s.configured ? 'configured-not-ready' : 'empty';

  const tone =
    state === 'ok' ? { chip: 'chip chip-success', label: "З'єднано" }
    : state === 'configured-not-ready' ? { chip: 'chip chip-warning', label: 'Налаштовано, не зʼєднано' }
    : { chip: 'chip chip-danger', label: 'Порожня' };

  const acct = s.account;
  const displayName = [acct?.firstName, acct?.lastName].filter(Boolean).join(' ') || null;

  return (
    <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
      <div style={{
        display: 'inline-flex', flexShrink: 0, padding: 10, borderRadius: 'var(--radius-pill)',
        background: 'var(--color-surface-3)', color: 'var(--color-ink)',
      }}>
        <Icon name="discovery" size={18} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.label}</span>
          <span className={tone.chip} title="Стан акаунта-трекера через MTProto">{tone.label}</span>
          {s.shared && (
            <span className="chip" title="Використовується спільна сесія публікатора (TELEGRAM_SESSION_STRING)">shared</span>
          )}
          {acct?.isPremium && <span className="chip chip-success">premium</span>}
        </div>

        {/* Account behind the session */}
        {acct ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            <Meta label="Акаунт">
              {acct.username
                ? <span style={{ color: 'var(--color-ink)' }}>@{acct.username}</span>
                : <span style={{ color: 'var(--color-ink-dim)' }}>без username</span>}
            </Meta>
            {displayName && <Meta label="Імʼя"><span style={{ color: 'var(--color-ink)' }}>{displayName}</span></Meta>}
            {acct.phone && (
              <Meta label="Телефон">
                <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>+{acct.phone}</span>
              </Meta>
            )}
            {acct.id && (
              <Meta label="User id">
                <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>{acct.id}</span>
              </Meta>
            )}
          </div>
        ) : (
          <p className="text-body-sm" style={{ margin: '8px 0 0', color: 'var(--color-ink-muted)' }}>
            {state === 'empty'
              ? 'Сесія не налаштована.'
              : 'Дані акаунта недоступні (сесія не зʼєднана).'}
          </p>
        )}

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
          <Meta label="ENV-змінна">
            <code style={{ color: 'var(--color-ink)' }}>{s.envVar}</code>
          </Meta>
          <Meta label="API-ключі">
            {s.hasApiCreds
              ? <span style={{ color: 'var(--color-success)' }}>є</span>
              : <span style={{ color: 'var(--color-danger)' }}>відсутні</span>}
          </Meta>
        </div>

        {state === 'empty' && (
          <div className="callout-warning" style={{ marginTop: 12 }}>
            <Icon name="warning" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Задайте <code>TELEGRAM_API_ID</code>, <code>TELEGRAM_API_HASH</code> та
              {' '}<code>{s.envVar}</code> у <code>.env</code>, потім перезапустіть automation —
              статистика й відстеження ввімкнуться.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 2 }}>{label}</div>
      <div className="text-body-sm">{children}</div>
    </div>
  );
}
