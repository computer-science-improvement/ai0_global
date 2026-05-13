import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { authApi, type TelegramLoginPayload } from '../api/auth';
import { TG_BOT_USERNAME } from '../lib/env';
import { useAuth } from '../auth/use-auth';

export const Route = createFileRoute('/login')({ component: LoginPage });

declare global { interface Window { onTelegramAuth: (u: TelegramLoginPayload) => void; } }

function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!widgetRef.current) return;
    window.onTelegramAuth = async (user) => {
      try {
        await authApi.telegramLogin(user);
        await refresh();
        await navigate({ to: '/channels' as any });
      } catch (e: unknown) {
        alert(`Login failed: ${(e as Error).message}`);
      }
    };
    if (!TG_BOT_USERNAME) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', TG_BOT_USERNAME);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    widgetRef.current.appendChild(s);
  }, [navigate, refresh]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="space-y-6 rounded-xl bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-2xl font-bold">Channel Tracker</h1>
        <p className="text-sm text-neutral-400">Sign in with Telegram to continue.</p>
        <div ref={widgetRef} />
        {!TG_BOT_USERNAME && (
          <p className="text-xs text-red-400">
            VITE_TG_BOT_USERNAME not set — widget cannot render.
          </p>
        )}
      </div>
    </div>
  );
}
