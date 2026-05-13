import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { authApi } from '../api/auth';
import { TG_BOT_USERNAME } from '../lib/env';
import type { Me } from '../api/types';

interface AuthState { me: Me | null; loading: boolean; refresh: () => Promise<void>; }

const AuthContext = createContext<AuthState | null>(null);

/**
 * Dev-mode bypass: when VITE_TG_BOT_USERNAME is not set we can't render the
 * Telegram Login Widget, so there's no way to authenticate via the proper path.
 * Mirror the backend's dev-bypass (no TRACKING_TOKEN → guard returns true) by
 * treating the user as authenticated with a placeholder identity. Production
 * MUST set VITE_TG_BOT_USERNAME and the user goes through the real flow.
 */
const DEV_USER: Me = { tgUserId: 0, firstName: 'Dev', username: 'dev' };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      if (!TG_BOT_USERNAME) {
        setMe(DEV_USER);
        return;
      }
      setMe(await authApi.me());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  return <AuthContext.Provider value={{ me, loading, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuthCtx(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
