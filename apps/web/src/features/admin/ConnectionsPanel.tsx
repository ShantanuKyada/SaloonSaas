import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plug, Plus, Send, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, Skeleton } from '@/components/ui/display';
import { Field, FormError, Input, Select, Switch } from '@/components/ui/form';
import { Modal, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';

interface Connection { id: string; kind: string; provider: string; displayName: string; branchId: string | null; config: Record<string, string | number | boolean>; secretKeys: string[]; hasWebhookSecret: boolean; webhookUrl: string | null; status: string; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null }
interface ConnectionList { items: Connection[]; platformChannels: string[] }
interface FieldDef { key: string; label: string; where: 'config' | 'secret'; required?: boolean; placeholder?: string; hint?: string; type?: 'text' | 'number' | 'password' | 'bool' }
interface Kind { id: string; kind: string; provider: string; title: string; description: string; fields: FieldDef[]; testable: 'message' | 'device' | 'none' }

const KINDS: Kind[] = [
  { id: 'whatsapp', kind: 'whatsapp', provider: 'meta_cloud', title: 'WhatsApp', description: 'Send confirmations, reminders and receipts on WhatsApp Business (Meta Cloud API).', testable: 'message', fields: [
    { key: 'phoneNumberId', label: 'Phone number ID', where: 'config', required: true, hint: 'From Meta Business → WhatsApp → API setup.' },
    { key: 'accessToken', label: 'Access token', where: 'secret', required: true, type: 'password', hint: 'A permanent system-user token. Stored encrypted and never shown again.' },
    { key: 'languageCode', label: 'Template language', where: 'config', placeholder: 'en' },
  ] },
  { id: 'email', kind: 'email', provider: 'smtp', title: 'Email', description: 'Send email through your own mail server (SMTP).', testable: 'message', fields: [
    { key: 'host', label: 'Mail server', where: 'config', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', where: 'config', type: 'number', placeholder: '587' },
    { key: 'secure', label: 'Use a secure connection (SSL, usually port 465)', where: 'config', type: 'bool' },
    { key: 'user', label: 'Username', where: 'config' },
    { key: 'password', label: 'Password', where: 'secret', type: 'password' },
    { key: 'from', label: 'Send from', where: 'config', required: true, placeholder: 'Glow Salon <hello@glow.example>' },
  ] },
  { id: 'sms', kind: 'sms', provider: 'http', title: 'SMS', description: 'Send text messages through an SMS gateway with an HTTP API.', testable: 'message', fields: [
    { key: 'apiUrl', label: 'Gateway address', where: 'config', required: true, placeholder: 'https://api.smsgateway.example/send' },
    { key: 'senderId', label: 'Sender name', where: 'config' },
    { key: 'apiKey', label: 'API key', where: 'secret', required: true, type: 'password' },
  ] },
  { id: 'biometric_pull', kind: 'biometric', provider: 'generic_http', title: 'Attendance machine (we fetch punches)', description: 'We check your attendance system regularly and copy new punches.', testable: 'device', fields: [
    { key: 'apiUrl', label: 'Attendance system address', where: 'config', required: true, placeholder: 'https://attendance.example/api/punches' },
    { key: 'apiKey', label: 'API key', where: 'secret', type: 'password' },
  ] },
  { id: 'biometric_push', kind: 'biometric', provider: 'push_webhook', title: 'Attendance machine (it sends punches)', description: 'Your device or its cloud sends each punch to a private web address we give you.', testable: 'device', fields: [] },
];
const kindOf = (c: Connection) => KINDS.find((k) => k.kind === c.kind && k.provider === c.provider);

/** Messaging and attendance connections. Passwords and tokens are written once, stored encrypted and never shown again. */
export function ConnectionsPanel() {
  const confirm = useConfirm();
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [adding, setAdding] = useState<Kind | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<Connection | null>(null);
  const [revealed, setRevealed] = useState<{ url: string | null; secret: string } | null>(null);
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<ConnectionList>('/integrations') });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/integrations/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: ['integrations'] }); void client.invalidateQueries({ queryKey: ['notifications', 'summary'] }); toast.success('Disconnected'); }, onError: toastError });
  const rotate = useMutation({ mutationFn: (c: Connection) => api.post<{ webhookSecret: string }>(`/integrations/${c.id}/rotate-secret`).then((r) => ({ ...r, url: c.webhookUrl })), onSuccess: (r) => setRevealed({ url: r.url, secret: r.webhookSecret }), onError: toastError });

  return (
    <div className="space-y-5">
      <InlineNotice tone="info" title="Your keys are safe">Tokens and passwords are encrypted when saved and can never be read back, only replaced.</InlineNotice>
      {q.isLoading && <Skeleton className="h-32" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.items.length === 0 && <Card><EmptyState icon={<Plug className="size-8" />} title="Nothing connected yet" description="Connect WhatsApp, email or SMS so customers receive confirmations and reminders." /></Card>}
      <ul className="grid gap-4 md:grid-cols-2">
        {q.data?.items.map((c) => {
          const kind = kindOf(c);
          return (
            <li key={c.id}>
              <Card className="h-full">
                <div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold">{c.displayName}</h3><p className="text-sm text-muted">{kind?.title ?? c.kind}</p></div><Badge tone={c.lastError ? 'warning' : c.status === 'active' ? 'success' : 'neutral'}>{c.lastError ? 'Needs attention' : c.status === 'active' ? 'Working' : 'Paused'}</Badge></div>
                {c.lastError && <p className="mt-2 text-sm text-danger">{c.lastError}</p>}
                <p className="mt-2 text-xs text-muted">{c.lastSuccessAt ? `Last worked ${fmtDateTime(c.lastSuccessAt, timezone)}` : 'Not used yet'}</p>
                {c.webhookUrl && <p className="mt-2 break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{c.webhookUrl}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(c)}>Edit</Button>
                  {kind?.testable !== 'none' && <Button size="sm" variant="outline" icon={<Send className="size-4" />} onClick={() => setTesting(c)}>{kind?.testable === 'device' ? 'Check now' : 'Send a test'}</Button>}
                  {c.provider === 'push_webhook' && <Button size="sm" variant="ghost" loading={rotate.isPending} onClick={async () => { if (await confirm({ title: 'Create a new secret?', body: 'The device stops working until you enter the new secret on it.', confirmLabel: 'Create new secret', cancelLabel: 'Keep current' })) rotate.mutate(c); }}>New secret</Button>}
                  <Button size="sm" variant="ghost" icon={<Unplug className="size-4" />} onClick={async () => { if (await confirm({ title: `Disconnect “${c.displayName}”?`, body: kind?.kind === 'biometric' ? 'Attendance stops updating from this device. Past punches are kept.' : 'Messages on this channel stop being sent. Messages already sent are not affected.', confirmLabel: 'Disconnect', cancelLabel: 'Keep connected', tone: 'danger' })) remove.mutate(c.id); }}>Disconnect</Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <section aria-label="Add a connection">
        <h3 className="mb-2 text-sm font-semibold">Add a connection</h3>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {KINDS.map((k) => (
            <li key={k.id}><button type="button" onClick={() => setAdding(k)} className="flex h-full w-full flex-col items-start gap-1 rounded-xl border border-line bg-surface p-4 text-left shadow-card transition hover:border-primary/50"><span className="flex items-center gap-2 font-medium"><Plus className="size-4 text-primary" aria-hidden />{k.title}</span><span className="text-sm text-muted">{k.description}</span></button></li>
          ))}
        </ul>
      </section>
      {adding && <ConnectionModal kind={adding} onClose={() => setAdding(null)} onCreated={(r) => { if (r.webhookSecretOnce) setRevealed({ url: r.webhookUrl, secret: r.webhookSecretOnce }); }} />}
      {editing && kindOf(editing) && <ConnectionModal kind={kindOf(editing)!} existing={editing} onClose={() => setEditing(null)} />}
      {testing && <TestModal connection={testing} kind={kindOf(testing)!} onClose={() => setTesting(null)} />}
      {revealed && (
        <Modal open onOpenChange={(o) => !o && setRevealed(null)} title="Enter these on the attendance device" description="This secret is shown only once. Copy it now." footer={<Button onClick={() => setRevealed(null)}>I have saved it</Button>}>
          <div className="space-y-3 text-sm">
            {revealed.url && <div><p className="mb-1 font-medium">Web address</p><p className="break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{revealed.url}</p></div>}
            <div><p className="mb-1 font-medium">Secret</p><div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{revealed.secret}</p><Button size="sm" variant="outline" icon={<Copy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(revealed.secret).then(() => toast.success('Copied')); }}>Copy</Button></div></div>
            <p className="text-muted">The device signs each request with this secret so only genuine punches are accepted.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ConnectionModal({ kind, existing, onClose, onCreated }: { kind: Kind; existing?: Connection; onClose: () => void; onCreated?: (r: Connection & { webhookSecretOnce?: string | null }) => void }) {
  const client = useQueryClient();
  const { branches } = useBranch();
  const [name, setName] = useState(existing?.displayName ?? kind.title.replace(/\s*\(.*\)/, ''));
  const [branchId, setBranchId] = useState(existing?.branchId ?? '');
  const [active, setActive] = useState(existing ? existing.status === 'active' : true);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(kind.fields.filter((f) => f.where === 'config').map((f) => [f.key, (existing?.config[f.key] as string | boolean | undefined) ?? (f.type === 'bool' ? false : '')])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, value: string | boolean) => { setValues((v) => ({ ...v, [key]: value })); setErrors({}); setError(null); };
  const save = useMutation({
    mutationFn: () => {
      const missing: Record<string, string> = {};
      const config: Record<string, string | number | boolean> = {};
      const secrets: Record<string, string> = {};
      for (const f of kind.fields) {
        const v = values[f.key];
        if (f.where === 'secret') {
          if (typeof v === 'string' && v) secrets[f.key] = v;
          else if (f.required && !existing?.secretKeys.includes(f.key)) missing[f.key] = `${f.label} is required.`;
        } else if (f.type === 'bool') config[f.key] = !!v;
        else if (typeof v === 'string' && v.trim()) config[f.key] = f.type === 'number' ? Number(v) : v.trim();
        else if (f.required) missing[f.key] = `${f.label} is required.`;
      }
      if (name.trim().length < 2) missing.displayName = 'Give this connection a name.';
      if (Object.keys(missing).length) { setErrors(missing); throw new Error('Please fill in the highlighted fields.'); }
      const body = { kind: kind.kind, provider: kind.provider, displayName: name.trim(), branchId: branchId || null, config, secrets, status: active ? 'active' : 'inactive' };
      return existing ? api.put<Connection & { webhookSecretOnce?: string | null }>(`/integrations/${existing.id}`, body) : api.post<Connection & { webhookSecretOnce?: string | null }>('/integrations', body);
    },
    onSuccess: (r) => { void client.invalidateQueries({ queryKey: ['integrations'] }); void client.invalidateQueries({ queryKey: ['notifications', 'summary'] }); toast.success(existing ? 'Connection updated' : 'Connected'); onCreated?.(r); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) setErrors((x) => ({ ...x, [path.replace(/^(config|secrets)\./, '')]: message }));
      setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={existing ? `Edit ${existing.displayName}` : `Connect ${kind.title}`} description={kind.description} persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{existing ? 'Save changes' : 'Connect'}</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Name" required error={errors.displayName}><Input value={name} onChange={(e) => { setName(e.target.value); setErrors({}); }} /></Field>
        {kind.fields.map((f) => f.type === 'bool'
          ? <Switch key={f.key} checked={!!values[f.key]} onCheckedChange={(v) => set(f.key, v)} label={f.label} />
          : f.where === 'secret'
            ? <Field key={f.key} label={f.label} required={f.required && !existing?.secretKeys.includes(f.key)} optional={!f.required} error={errors[f.key]} hint={existing?.secretKeys.includes(f.key) ? 'Saved. Leave empty to keep it, or type a new one to replace it.' : f.hint}><Input type="password" autoComplete="new-password" placeholder={existing?.secretKeys.includes(f.key) ? '••••••••••' : undefined} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} /></Field>
            : <Field key={f.key} label={f.label} required={f.required} optional={!f.required} error={errors[f.key]} hint={f.hint}><Input type={f.type === 'number' ? 'number' : 'text'} placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} /></Field>)}
        {branches.length > 1 && kind.kind === 'biometric' && <Field label="Branch" hint="Which branch’s staff punch on this device."><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
        <Switch checked={active} onCheckedChange={setActive} label="Use this connection" description="Switch off to pause it without losing the settings." />
      </div>
    </Modal>
  );
}

function TestModal({ connection, kind, onClose }: { connection: Connection; kind: Kind; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const client = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<{ ok: boolean; detail: string }>(`/integrations/${connection.id}/test`, kind.testable === 'message' ? { to } : {}),
    onSuccess: (r) => { setResult(r); void client.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e) => setResult({ ok: false, detail: friendlyError(e).message }),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={kind.testable === 'device' ? 'Check the connection' : 'Send a test message'} size="sm" footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button loading={run.isPending} disabled={kind.testable === 'message' && to.trim().length < 5} onClick={() => { setResult(null); run.mutate(); }}>{kind.testable === 'device' ? 'Check now' : 'Send test'}</Button></>}>
      <div className="space-y-4">
        {kind.testable === 'message' && <Field label={connection.kind === 'email' ? 'Send the test to this email' : 'Send the test to this mobile number'} required><Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} type={connection.kind === 'email' ? 'email' : 'tel'} /></Field>}
        {result && <InlineNotice tone={result.ok ? 'success' : 'danger'} title={result.ok ? 'It works' : 'It did not work'}>{result.detail}</InlineNotice>}
      </div>
    </Modal>
  );
}
