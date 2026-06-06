// Read-only status card for the MTProto tracking session. The session string
// lives in .env (TELEGRAM_TRACKING_SESSION_STRING, or the shared publisher
// session) — this card never shows or edits the secret, only whether the
// tracker can reach Telegram for stats/competitor polling.

import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../../api/tracking';
import { Icon } from '../Icon';

export function SessionCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tracking-session'],
    queryFn:  () => trackingApi.sessionStatus(),
    refetchInterval: 30_000,
  });

  const state: 'ok' | 'configured-not-ready' | 'empty' | 'unknown' =
    !data ? 'unknown'
    : data.ready ? 'ok'
    : data.configured ? 'configured-not-ready'
    : 'empty';

  const tone =
    state === 'ok' ? { chip: 'chip chip-success', label: "З'єднано" }
    : state === 'configured-not-ready' ? { chip: 'chip chip-warning', label: 'Налаштовано, не зʼєднано' }
    : state === 'empty' ? { chip: 'chip chip-danger', label: 'Сесія порожня' }
    : { chip: 'chip', label: '—' };

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
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
            MTProto-сесія
          </span>
          {isLoading
            ? <span className="chip">…</span>
            : <span className={tone.chip} title="Стан акаунта-трекера, що збирає статистику та відстежує канали через MTProto">{tone.label}</span>}
          {data?.shared && (
            <span className="chip" title="Використовується спільна сесія публікатора (TELEGRAM_SESSION_STRING), а не окрема трекерська">
              shared
            </span>
          )}
        </div>

        <p className="text-body-sm" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)', lineHeight: 1.45 }}>
          Користувацький акаунт, яким трекер читає статистику каналів і стрічки конкурентів.
          Рядок сесії зберігається у <code style={{ color: 'var(--color-ink)' }}>.env</code> — додати чи замінити його можна лише там.
        </p>

        {error && (
          <p className="text-body-sm" style={{ margin: '8px 0 0', color: 'var(--color-danger)' }}>
            {(error as Error).message}
          </p>
        )}

        {data && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            <Meta label="ENV-змінна">
              <code style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>{data.envVar}</code>
            </Meta>
            <Meta label="API-ключі">
              {data.hasApiCreds
                ? <span style={{ color: 'var(--color-success)' }}>є</span>
                : <span style={{ color: 'var(--color-danger)' }}>відсутні</span>}
            </Meta>
          </div>
        )}

        {state === 'empty' && (
          <div className="callout-warning" style={{ marginTop: 12 }}>
            <Icon name="warning" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Сесія не налаштована — статистика й відстеження каналів вимкнені.
              Задайте <code>TELEGRAM_API_ID</code>, <code>TELEGRAM_API_HASH</code> та
              {' '}<code>TELEGRAM_TRACKING_SESSION_STRING</code> у <code>.env</code>, потім перезапустіть automation.
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
