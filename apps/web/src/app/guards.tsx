import type { Permission } from '@salon/shared';
import { Lock } from 'lucide-react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '@/components/ui/display';
import { ButtonLink } from '@/components/ui/button';
import { homePath, useAuth, useCan, useUser } from '@/lib/auth';

/** Everything behind sign-in. Remembers where the person was going so sign-in can take them back. */
export function RequireAuth() {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="grid min-h-dvh place-items-center"><Spinner label="Opening your salon…" /></div>;
  if (status === 'anonymous' || !user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  // The salon requires two-step sign-in and it is not set up yet: the server only allows the account and security
  // routes until it is, so the app sends the person straight to the screen that sets it up.
  if (user.twoFactor.setupRequired && location.pathname !== '/security' && location.pathname !== '/change-password') return <Navigate to="/security" replace />;
  return <Outlet />;
}

export function Forbidden() {
  const user = useUser();
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <span className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-surface-2 text-muted"><Lock className="size-6" aria-hidden /></span>
      <h1 className="text-xl font-semibold">This page is not part of your role</h1>
      <p className="mt-2 text-muted">If you think you should have access, ask the owner or manager to update your role.</p>
      <div className="mt-6"><ButtonLink to={homePath(user)}>Go to my home screen</ButtonLink></div>
    </div>
  );
}

/** Shows the page only to people holding at least one of the listed permissions (the API enforces the same rules). */
export function RequirePermission({ any }: { any: Permission[] }) {
  const can = useCan();
  const user = useUser();
  if (user.isPlatformAdmin) return <Forbidden />;
  return can(any) ? <Outlet /> : <Forbidden />;
}

export function RequirePlatformAdmin() {
  const user = useUser();
  return user.isPlatformAdmin ? <Outlet /> : <Forbidden />;
}

/** The "/" address sends each person to the screen their role starts on. */
export function HomeRedirect() {
  const user = useUser();
  return <Navigate to={homePath(user)} replace />;
}

export function NotFound() {
  const { status, user } = useAuth();
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <p className="text-5xl font-semibold text-primary">404</p>
      <h1 className="mt-3 text-xl font-semibold">We could not find that page</h1>
      <p className="mt-2 text-muted">The address may be mistyped, or the page may have moved.</p>
      <div className="mt-6">{status === 'authenticated' && user ? <ButtonLink to={homePath(user)}>Go to my home screen</ButtonLink> : <Link className="font-medium text-primary hover:underline" to="/login">Go to sign in</Link>}</div>
    </div>
  );
}
