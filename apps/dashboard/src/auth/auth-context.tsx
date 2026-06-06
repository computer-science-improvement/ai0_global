import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { authApi } from '../api/auth';
import { AUTH_MODE } from '../lib/env';
import type { Me } from '../api/types';

interface AuthState { me: Me | null; loading: boolean; refresh: () => Promise<void>; }

const AuthContext = createContext<AuthState | null>(null);

/**
 * Dev-mode bypass: in 'dev' mode there's no auth configured, so mirror the
 * backend's dev-bypass (no TRACKING_TOKEN → guard returns true) with a
 * placeholder identity. In 'telegram' / 'token' modes we always consult
 * /auth/me (cookie-backed) so a real session is required.
 */
const DEV_USER: Me = { tgUserId: 0, firstName: 'Dev', username: 'dev' };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      if (AUTH_MODE === 'dev') {
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
