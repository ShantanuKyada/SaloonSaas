import type { FeatureKey, LoginResponse, MfaChallenge, Permission, SessionUser } from '@salon/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onSessionLost, onSupportEnded, onUserStale, refreshSession, setAccessToken, setRefreshHandler, setSupportMode, type RefreshResult } from './api';

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
  /** Platform administrators: work inside a salon (support mode), and come back to the platform. */
  enterSupport: (session: SupportSession) => void;
  exitSupport: () => Promise<void>;
}

export interface SupportSession {
  accessToken: string;
  expiresAt: string;
  user: SessionUser;
}

// Kept for this browser tab only, so a reload stays in the salon until the support session runs out.
const SUPPORT_KEY = 'salonos:support';
function storedSupport(): SupportSession | null {
  try {
    const raw = sessionStorage.getItem(SUPPORT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SupportSession;
    return new Date(s.expiresAt).getTime() > Date.now() + 5_000 ? s : (sessionStorage.removeItem(SUPPORT_KEY), null);
  } catch {
    return null;
  }
}
function storeSupport(s: SupportSession | null) {
  try {
    if (s) sessionStorage.setItem(SUPPORT_KEY, JSON.stringify({ accessToken: s.accessToken, expiresAt: s.expiresAt }));
    else sessionStorage.removeItem(SUPPORT_KEY);
  } catch {
    /* storage unavailable: support mode then lasts until the page is reloaded */
  }
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
    // Back from a reload inside a salon (support mode): use that session, not the platform one.
    const support = storedSupport();
    if (support) {
      setAccessToken(support.accessToken);
      setSupportMode(true);
      void api.get<SessionUser>('/auth/me').then(
        (u) => {
          setUser(u);
          setStatus('authenticated');
        },
        () => {
          storeSupport(null);
          setSupportMode(false);
          void refreshSession().then((ok) => !ok && setStatus('anonymous'));
        },
      );
    } else {
      void refreshSession().then((ok) => {
        if (!ok) setStatus('anonymous');
      });
    }
    return () => {
      stop();
      stopStale();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [apply, client]);

  // Leaving support mode (by choice or when it runs out): back to the platform administrator's own session.
  const supportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveSupport = useCallback(async () => {
    storeSupport(null);
    setSupportMode(false);
    if (supportTimer.current) clearTimeout(supportTimer.current);
    client.clear();
    const ok = await refreshSession();
    if (!ok) {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, [client]);
  useEffect(() => {
    const off = onSupportEnded(() => void leaveSupport());
    return () => {
      off();
    };
  }, [leaveSupport]);
  useEffect(() => {
    if (!user?.support) return;
    const stored = storedSupport();
    const ms = new Date(stored?.expiresAt ?? user.support.expiresAt).getTime() - Date.now();
    supportTimer.current = setTimeout(() => void leaveSupport(), Math.max(ms, 1_000));
    return () => {
      if (supportTimer.current) clearTimeout(supportTimer.current);
    };
  }, [user?.support, leaveSupport]);

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
        // Signing out inside a salon ends the support session too, so the next sign-in starts on the platform.
        if (supportTimer.current) clearTimeout(supportTimer.current);
        storeSupport(null);
        setSupportMode(false);
        setAccessToken(null);
        setUser(null);
        setStatus('anonymous');
        setSessionExpired(false);
        client.clear();
      },
      async reloadUser() {
        setUser(await api.get<SessionUser>('/auth/me'));
      },
      enterSupport(session) {
        // The platform session's renewal timer would swap this token back: stop it while inside the salon.
        if (timer.current) clearTimeout(timer.current);
        client.clear();
        storeSupport(session);
        setSupportMode(true);
        setAccessToken(session.accessToken);
        setUser(session.user);
        setStatus('authenticated');
      },
      exitSupport: leaveSupport,
    }),
    [status, user, sessionExpired, apply, client, leaveSupport],
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

/** Is this feature switched on for the user's salon? (The platform can switch features off per salon.) */
export function useFeature(): (feature: FeatureKey) => boolean {
  const { user } = useAuth();
  const off = user?.organization?.disabledFeatures;
  return useCallback((f) => !off?.includes(f), [off]);
}

export function Can({ permission, children, fallback = null }: { permission: Permission | Permission[]; children: ReactNode; fallback?: ReactNode }) {
  const can = useCan();
  return <>{can(permission) ? children : fallback}</>;
}

/** Where each role lands after signing in. */
export function homePath(user: SessionUser): string {
  if (user.isPlatformAdmin && !user.support) return '/platform';
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
