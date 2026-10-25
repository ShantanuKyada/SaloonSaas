import type { LoginResponse, MfaChallenge, Permission, SessionUser } from '@salon/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onSessionLost, onUserStale, refreshSession, setAccessToken, setRefreshHandler, type RefreshResult } from './api';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: Status;
  user: SessionUser | null;
  sessionExpired: boolean;
  /** Resolves with the signed-in user, or with a challenge when the second step (a code) is still needed. */
  login: (identifier: string, password: string) => Promise<SessionUser | MfaChallenge>;
  /** Finishes a sign-in that asked for a code (an authenticator code or a recovery code). */
  completeMfa: (mfaToken: string, code: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback((expiresIn: number) => {
    if (timer.current) clearTimeout(timer.current);
    // Renew a minute before the access token expires so a working receptionist is never interrupted.
    timer.current = setTimeout(() => void refreshSession(), Math.max((expiresIn - 60) * 1000, 30_000));
  }, []);

  const apply = useCallback(
    (r: RefreshResult | LoginResponse) => {
      setAccessToken(r.accessToken);
      setUser(r.user as SessionUser);
      setStatus('authenticated');
      setSessionExpired(false);
      schedule(r.expiresIn);
    },
    [schedule],
  );

  useEffect(() => {
    setRefreshHandler(apply);
    const stop = onSessionLost(() => {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
      setSessionExpired(true);
      client.clear();
    });
    const stopStale = onUserStale(() => {
      void api.get<SessionUser>('/auth/me').then(setUser, () => undefined);
    });
    void refreshSession().then((ok) => {
      if (!ok) setStatus('anonymous');
    });
    return () => {
      stop();
      stopStale();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [apply, client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionExpired,
      async login(identifier, password) {
        const res = await api.post<LoginResponse | MfaChallenge>('/auth/login', { identifier, password });
        if ('mfaRequired' in res) return res;
        client.clear();
        apply(res);
        return res.user;
      },
      async completeMfa(mfaToken, code) {
        const res = await api.post<LoginResponse>('/auth/login/mfa', { mfaToken, code });
        client.clear();
        apply(res);
        return res.user;
      },
      async logout() {
        await api.post('/auth/logout').catch(() => undefined);
        if (timer.current) clearTimeout(timer.current);
        setAccessToken(null);
        setUser(null);
        setStatus('anonymous');
        setSessionExpired(false);
        client.clear();
      },
      async reloadUser() {
        setUser(await api.get<SessionUser>('/auth/me'));
      },
    }),
    [status, user, sessionExpired, apply, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** The signed-in user; only call inside routes behind the authentication guard. */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user');
  return user;
}

export function useCan(): (permission: Permission | Permission[]) => boolean {
  const { user } = useAuth();
  const set = useMemo(() => new Set(user?.permissions ?? []), [user]);
  return useCallback((p) => (Array.isArray(p) ? p.some((x) => set.has(x)) : set.has(p)), [set]);
}

export function Can({ permission, children, fallback = null }: { permission: Permission | Permission[]; children: ReactNode; fallback?: ReactNode }) {
  const can = useCan();
  return <>{can(permission) ? children : fallback}</>;
}

/** Where each role lands after signing in. */
export function homePath(user: SessionUser): string {
  if (user.isPlatformAdmin) return '/platform';
  switch (user.role?.homeScreen) {
    case 'owner_dashboard':
      return '/dashboard';
    case 'branch_dashboard':
      return '/today';
    case 'my_day':
      return '/my-day';
    default:
      return '/desk';
  }
}
