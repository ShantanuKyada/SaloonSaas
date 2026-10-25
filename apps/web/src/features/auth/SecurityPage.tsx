import { mfaConfirmSchema, type TwoFactorSetup } from '@salon/shared';
import { useMutation } from '@tanstack/react-query';
import { Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Badge, Card, CardHeader, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Checkbox, Field, FormError, Input } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { homePath, useAuth, useUser } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

const RECOVERY_CODE_COUNT = 10;

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Could not copy. Select the text and copy it by hand.');
  }
}

function downloadCodes(codes: string[], who: string) {
  const text = `SalonOS recovery codes for ${who}\nEach code works once. Keep this file somewhere safe and private.\n\n${codes.join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'salonos-recovery-codes.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function Component() {
  const me = useUser();
  const { reloadUser } = useAuth();
  const navigate = useNavigate();
  const tf = me.twoFactor;
  const [wizard, setWizard] = useState(false);
  const [confirming, setConfirming] = useState<'disable' | 'codes' | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const who = me.email ?? me.phone ?? me.fullName;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader title="Account security" description="Protect your account with a code from your phone, and keep your password up to date." />
      {tf.setupRequired && (
        <InlineNotice tone="warning" title="Set up two-step sign-in to continue">
          Your salon requires it for your role. It takes about a minute. Until it is on, the rest of the app stays locked.
        </InlineNotice>
      )}

      <Card>
        <CardHeader
          title="Two-step sign-in"
          description="After your password, you enter a 6-digit code from an authenticator app on your phone. A stolen password alone then cannot open your account."
          actions={<Badge tone={tf.enabled ? 'success' : 'neutral'} dot>{tf.enabled ? 'On' : 'Off'}</Badge>}
        />
        {tf.enabled ? (
          <div className="space-y-4">
            <p className="text-sm">
              <ShieldCheck className="mr-1.5 inline size-4 text-success" aria-hidden />
              Each time you sign in you will be asked for the code shown in your authenticator app.
            </p>
            <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
              <p className="font-medium">Recovery codes: {tf.recoveryCodesLeft} of {RECOVERY_CODE_COUNT} left</p>
              <p className="mt-0.5 text-muted">If you lose your phone, a recovery code lets you sign in once. Make new ones if you are running low or think someone saw them.</p>
              {tf.recoveryCodesLeft <= 2 && <p className="mt-2 font-medium text-warning">You are running low. Make new recovery codes soon.</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" icon={<KeyRound className="size-4" />} onClick={() => setConfirming('codes')}>Make new recovery codes</Button>
              {!tf.required && <Button variant="outline" onClick={() => setConfirming('disable')}>Turn off two-step sign-in</Button>}
            </div>
            {tf.required && <p className="text-sm text-muted">Your salon requires two-step sign-in for your role, so it cannot be turned off. An owner can change this under Settings → Privacy.</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted">You will need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or Authy.</p>
            <Button icon={<ShieldCheck className="size-4" />} onClick={() => setWizard(true)}>Turn on two-step sign-in</Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Password" description="Use at least 10 characters with a letter and a number." />
        <ButtonLink to="/change-password" variant="outline" icon={<KeyRound className="size-4" />}>Change password</ButtonLink>
      </Card>

      {wizard && (
        <SetupWizard
          who={who}
          onClose={() => setWizard(false)}
          onDone={async () => {
            // The screen is reloaded only now: switching on may unlock the rest of the app, which would otherwise replace this page while the recovery codes are still showing.
            await reloadUser();
            setWizard(false);
            toast.success('Two-step sign-in is on');
            if (tf.setupRequired) navigate(homePath(me), { replace: true });
          }}
        />
      )}
      {confirming && (
        <ConfirmWithCode
          kind={confirming}
          onClose={() => setConfirming(null)}
          onCodes={(codes) => { setConfirming(null); setFreshCodes(codes); }}
          onDisabled={async () => { await reloadUser(); setConfirming(null); toast.success('Two-step sign-in is off'); }}
        />
      )}
      {freshCodes && (
        <RecoveryCodesModal
          codes={freshCodes}
          who={who}
          title="Your new recovery codes"
          onDone={async () => { await reloadUser(); setFreshCodes(null); }}
        />
      )}
    </div>
  );
}

// ───────────── Recovery codes ─────────────
function RecoveryCodes({ codes, who }: { codes: string[]; who: string }) {
  return (
    <div className="space-y-3">
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-2 p-3">
        {codes.map((c) => <li key={c}><code className="font-mono text-sm font-medium tracking-wide text-fg">{c}</code></li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" icon={<Copy className="size-4" />} onClick={() => void copyText(codes.join('\n'), 'Recovery codes')}>Copy all</Button>
        <Button size="sm" variant="outline" icon={<Download className="size-4" />} onClick={() => downloadCodes(codes, who)}>Download as a file</Button>
      </div>
    </div>
  );
}

function RecoveryCodesModal({ codes, who, title, onDone }: { codes: string[]; who: string; title: string; onDone: () => void | Promise<void> }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && saved) void onDone(); }}
      title={title}
      description="The old codes no longer work. These are shown only once, so save them now."
      persistent
      footer={<Button disabled={!saved} loading={busy} onClick={async () => { setBusy(true); await onDone(); }}>Done</Button>}
    >
      <div className="space-y-4">
        <RecoveryCodes codes={codes} who={who} />
        <Checkbox checked={saved} onCheckedChange={setSaved} label="I have saved these codes somewhere safe" description="Each code works once. Keep them private, like a password." />
      </div>
    </Modal>
  );
}

// ───────────── Turning it on ─────────────
function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      // Loaded only here: the QR library is not part of the rest of the app.
      const mod: typeof import('qrcode') & { default?: typeof import('qrcode') } = await import('qrcode');
      const url = await (mod.default ?? mod).toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 208 });
      if (alive) setSrc(url);
    })();
    return () => { alive = false; };
  }, [value]);
  return src ? <img src={src} width={208} height={208} alt="QR code that adds SalonOS to your authenticator app" className="rounded-lg border border-line bg-white" /> : <Skeleton className="size-52" />;
}

function SetupWizard({ who, onClose, onDone }: { who: string; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Asking twice would replace the key that is already on the person's screen.
  const started = useRef(false);

  const begin = () => {
    setLoadError(null);
    api.post<TwoFactorSetup>('/auth/mfa/setup').then(setSetup).catch((e) => setLoadError(friendlyError(e).message));
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, []);

  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.replace(/\s/g, '') }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
    onError: (e) => setError(friendlyError(e).message),
  });
  const submit = () => {
    if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      setError('Enter the 6-digit code shown in your authenticator app.');
      return;
    }
    setError(null);
    enable.mutate();
  };

  const finish = async () => {
    setFinishing(true);
    await onDone();
  };

  if (codes) {
    return (
      <Modal
        open
        onOpenChange={(o) => { if (!o && saved) void finish(); }}
        title="Save your recovery codes"
        description="Two-step sign-in is on. If you lose your phone, each of these codes lets you sign in once. They are shown only once."
        persistent
        footer={<Button disabled={!saved} loading={finishing} onClick={() => void finish()}>Done</Button>}
      >
        <div className="space-y-4">
          <RecoveryCodes codes={codes} who={who} />
          <Checkbox checked={saved} onCheckedChange={setSaved} label="I have saved these codes somewhere safe" description="Keep them private, like a password." />
        </div>
      </Modal>
    );
  }

  const key = setup?.secret.match(/.{1,4}/g)?.join(' ') ?? '';
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Turn on two-step sign-in"
      description="Three quick steps."
      persistent
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={enable.isPending} disabled={!setup} onClick={submit}>Turn on</Button></>}
    >
      <ol className="space-y-5 text-sm">
        <li>
          <p className="font-medium">1. Install an authenticator app</p>
          <p className="text-muted">Google Authenticator, Microsoft Authenticator, Authy or 1Password all work.</p>
        </li>
        <li>
          <p className="font-medium">2. Add SalonOS to the app</p>
          {loadError ? (
            <div className="mt-2 space-y-2"><FormError message={loadError} /><Button size="sm" variant="outline" onClick={begin}>Try again</Button></div>
          ) : setup ? (
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
              <QrCode value={setup.otpauthUrl} />
              <div className="min-w-0 space-y-2">
                <p className="text-muted">Scan the code with the app. If you cannot scan, choose “enter a setup key” in the app and type this:</p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="sr-only">Setup key:</span>
                  <code data-testid="setup-key" className="rounded bg-surface-2 px-2 py-1 font-mono text-sm font-medium tracking-wider">{key}</code>
                  <Button size="sm" variant="outline" icon={<Copy className="size-4" />} onClick={() => void copyText(setup.secret, 'Setup key')}>Copy key</Button>
                </p>
              </div>
            </div>
          ) : (
            <Skeleton className="mt-2 h-52" />
          )}
        </li>
        <li>
          <p className="font-medium">3. Enter the code the app shows</p>
          <div className="mt-2 max-w-xs space-y-2">
            <FormError message={error} />
            <Field label="6-digit code" hint="It changes every 30 seconds.">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                spellCheck={false}
                placeholder="123 456"
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              />
            </Field>
          </div>
        </li>
      </ol>
    </Modal>
  );
}

// ───────────── Turning it off, or making new recovery codes ─────────────
function ConfirmWithCode({ kind, onClose, onCodes, onDisabled }: { kind: 'disable' | 'codes'; onClose: () => void; onCodes: (codes: string[]) => void; onDisabled: () => void | Promise<void> }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      const parsed = mfaConfirmSchema.safeParse({ password, code });
      if (!parsed.success) {
        const found: Record<string, string> = {};
        for (const i of parsed.error.issues) found[String(i.path[0])] ??= i.message;
        setErrors(found);
        throw new Error('Please fill in both boxes.');
      }
      if (kind === 'disable') {
        await api.post('/auth/mfa/disable', parsed.data);
        return null;
      }
      return (await api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', parsed.data)).recoveryCodes;
    },
    onSuccess: async (codes) => (codes ? onCodes(codes) : onDisabled()),
    onError: (e) => {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        setError(Object.keys(e.fieldErrors).length ? null : friendlyError(e).message);
      } else setError(e instanceof Error ? e.message : 'Please try again.');
    },
  });
  const disable = kind === 'disable';
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={disable ? 'Turn off two-step sign-in' : 'Make new recovery codes'}
      description={disable ? 'Your account will go back to a password only. Confirm it is you.' : 'The old recovery codes stop working as soon as you make new ones. Confirm it is you.'}
      size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant={disable ? 'danger' : 'primary'} loading={run.isPending} onClick={() => run.mutate()}>{disable ? 'Turn off' : 'Make new codes'}</Button></>}
    >
      <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <FormError message={error} />
        <Field label="Your password" error={errors.password}>
          <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setErrors({}); setError(null); }} />
        </Field>
        <Field label="Code from your authenticator app" error={errors.code} hint="Or one of your recovery codes.">
          <Input autoComplete="one-time-code" spellCheck={false} maxLength={20} value={code} onChange={(e) => { setCode(e.target.value); setErrors({}); setError(null); }} />
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>Confirm</button>
      </form>
    </Modal>
  );
}
