import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput, type MfaChallenge, type SessionUser } from '@salon/shared';
import { ArrowLeft, Eye, EyeOff, Scissors } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/display';
import { Field, FormError, Input } from '@/components/ui/form';
import { ApiError } from '@/lib/api';
import { homePath, useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export function Component() {
  const { status, user, login, completeMfa, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the password was right but the person has two-step sign-in on and still has to enter a code.
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { identifier: '', password: '' } });
  const from = (location.state as { from?: string } | null)?.from;

  if (status === 'authenticated' && user) return <Navigate to={from ?? homePath(user)} replace />;

  const arrive = (u: SessionUser) => navigate(from ?? (u.mustChangePassword ? '/change-password' : u.twoFactor.setupRequired ? '/security' : homePath(u)), { replace: true });

  const backToPassword = (message: string | null) => {
    setChallenge(null);
    setCode('');
    setCodeError(null);
    setRecovery(false);
    setError(message);
    form.resetField('password');
  };

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const result = await login(values.identifier, values.password);
      if ('mfaRequired' in result) {
        setChallenge(result);
        return;
      }
      arrive(result);
    } catch (e) {
      setError(friendlyError(e).message);
      form.setFocus('password');
    }
  });

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    if (code.trim().length < 6) {
      setCodeError(recovery ? 'Enter one of your recovery codes' : 'Enter the 6-digit code from your authenticator app');
      return;
    }
    setCodeError(null);
    setVerifying(true);
    try {
      arrive(await completeMfa(challenge.mfaToken, code));
    } catch (e) {
      // A wrong code can simply be retyped; an expired or locked sign-in has to start again with the password.
      if (e instanceof ApiError && (e.errorCode === 'SESSION_EXPIRED' || e.errorCode === 'ACCOUNT_LOCKED')) backToPassword(e.message);
      else setCodeError(friendlyError(e).message);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,520px)]">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-violet-700 via-fuchsia-700 to-rose-600 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-lg font-semibold">
          <span className="grid size-10 place-items-center rounded-xl bg-white/15"><Scissors className="size-5" /></span>
          SalonOS
        </div>
        <div className="max-w-md space-y-4">
          <h1 className="text-4xl font-semibold leading-tight">Run the whole salon from one calm screen.</h1>
          <p className="text-lg text-white/85">Bookings, walk-ins, bills, pending payments and your team’s day — simple enough to learn in minutes.</p>
        </div>
        <p className="text-sm text-white/70">Appointments · Customers · Billing · Reports</p>
        <div aria-hidden className="absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />
      </div>
      <main className="flex items-center justify-center bg-bg px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-fg"><Scissors className="size-5" /></span>
            <span className="text-lg font-semibold">SalonOS</span>
          </div>
          {challenge ? (
            <>
              <h2 className="text-2xl font-semibold tracking-tight">Two-step sign-in</h2>
              <p className="mt-1 text-sm text-muted">
                {recovery
                  ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'
                  : 'Open your authenticator app and enter the 6-digit code shown for SalonOS.'}
              </p>
              <form onSubmit={verify} className="mt-6 space-y-4" noValidate>
                <FormError message={codeError} />
                <Field label={recovery ? 'Recovery code' : '6-digit code'} hint={recovery ? undefined : 'The code changes every 30 seconds.'}>
                  <Input
                    key={recovery ? 'recovery' : 'code'}
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={recovery ? 'text' : 'numeric'}
                    spellCheck={false}
                    maxLength={recovery ? 20 : 7}
                    placeholder={recovery ? 'ABCDE-FGH23' : '123 456'}
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setCodeError(null); }}
                  />
                </Field>
                <Button type="submit" size="lg" className="w-full" loading={verifying}>Verify and sign in</Button>
              </form>
              <div className="mt-5 flex flex-col items-center gap-2 text-sm">
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setRecovery((r) => !r); setCode(''); setCodeError(null); }}>
                  {recovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
                </button>
                <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-fg" onClick={() => backToPassword(null)}>
                  <ArrowLeft className="size-3.5" aria-hidden /> Back to sign in
                </button>
              </div>
              <p className="mt-6 text-center text-xs text-muted">Lost your phone and your recovery codes? Ask your salon owner to reset two-step sign-in for you.</p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
              <p className="mt-1 text-sm text-muted">Sign in with your email or mobile number.</p>
              {sessionExpired && (
                <div className="mt-4">
                  <InlineNotice tone="warning" title="You were signed out">For your security, please sign in again.</InlineNotice>
                </div>
              )}
              <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
                <FormError message={error} />
                <Field label="Email or mobile number" error={form.formState.errors.identifier?.message}>
                  <Input autoComplete="username" autoFocus inputMode="email" placeholder="you@salon.com or 98765 43210" {...form.register('identifier')} />
                </Field>
                <Field label="Password" error={form.formState.errors.password?.message}>
                  <Input
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    suffix={
                      <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)} className="grid size-7 place-items-center rounded text-muted hover:bg-surface-2">
                        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    }
                    {...form.register('password')}
                  />
                </Field>
                <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
                  Sign in
                </Button>
              </form>
              <p className="mt-6 text-center text-xs text-muted">Forgot your password? Ask your salon owner or manager to reset it for you.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
