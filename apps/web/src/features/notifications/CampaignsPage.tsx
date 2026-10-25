import { NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_LABELS, TEMPLATE_VARIABLES, campaignSchema, type NotificationChannel, type SegmentFilterInput } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Send, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, type Tone } from '@/components/ui/display';
import { DateInput, Field, FormError, Input, Segmented, Select, Textarea, TimeInput } from '@/components/ui/form';
import { Drawer, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDateTime, toInstant, todayIn } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

interface Campaign { id: string; name: string; eventType: string; channel: NotificationChannel; status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'cancelled'; scheduledAt: string | null; recipientsCount: number; body: string; createdAt: string; results: Record<string, number> }
interface Segment { id: string; name: string; filter: SegmentFilterInput; customerCount: number }
interface Summary { connectedChannels: string[] }

const STATUS: Record<Campaign['status'], { label: string; tone: Tone }> = { draft: { label: 'Not sent yet', tone: 'neutral' }, scheduled: { label: 'Scheduled', tone: 'info' }, sending: { label: 'Sending', tone: 'warning' }, completed: { label: 'Finished', tone: 'success' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };
const EVENTS = [{ value: 'offer', label: 'An offer or announcement' }, { value: 're_engagement', label: 'We miss you' }, { value: 'birthday', label: 'Birthday wishes' }] as const;
const VARIABLES: Record<string, string> = { customerName: 'Customer name', salonName: 'Salon name', daysSinceLastVisit: 'Days since last visit' };

export function Component() {
  const manage = useCan()('campaigns.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const { timezone } = useBranch();
  const [params, setParams] = useSearchParams();
  const segmentParam = params.get('segment');
  const [creating, setCreating] = useState(!!segmentParam);
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api.get<Campaign[]>('/campaigns'), refetchInterval: 15_000 });
  const send = useMutation({
    mutationFn: (id: string) => api.post<{ queued: number }>(`/campaigns/${id}/send`),
    onSuccess: (r) => { void client.invalidateQueries({ queryKey: ['campaigns'] }); toast.success(r.queued === 0 ? 'Nobody to send to right now' : `${r.queued} messages are on their way`); },
    onError: toastError,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/campaigns/${id}/cancel`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['campaigns'] }); toast.success('Campaign cancelled. Unsent messages were stopped.'); },
    onError: toastError,
  });
  const close = () => { setCreating(false); if (segmentParam) { const next = new URLSearchParams(params); next.delete('segment'); setParams(next, { replace: true }); } };

  return (
    <div>
      <PageHeader title="Campaigns" description="Send an offer or a friendly nudge to a group of customers. Only customers who agreed to offers are contacted." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button>} />
      {q.isLoading && <div role="status" aria-label="Loading campaigns" className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.length === 0 && <Card><EmptyState icon={<Megaphone className="size-8" />} title="No campaigns yet" description="Create a group of customers first, then send them a message from here." action={manage && <div className="flex gap-2"><Button onClick={() => setCreating(true)}>New campaign</Button><Link className="inline-flex items-center text-sm font-medium text-primary hover:underline" to="/customers/segments">Customer groups</Link></div>} /></Card>}
      <ul className="space-y-3">
        {q.data?.map((c) => {
          const r = c.results;
          const delivered = (r.delivered ?? 0) + (r.read ?? 0);
          return (
            <li key={c.id}>
              <Card>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 basis-72">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{c.name}</h2><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge><Badge>{NOTIFICATION_CHANNEL_LABELS[c.channel]}</Badge></div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted">{c.body}</p>
                    <p className="mt-2 text-xs text-muted">{c.scheduledAt && c.status === 'scheduled' ? `Goes out ${fmtDateTime(c.scheduledAt, timezone)} · ` : ''}{c.recipientsCount} {c.recipientsCount === 1 ? 'customer' : 'customers'}{c.status !== 'draft' && c.status !== 'scheduled' ? ` · ${delivered} delivered${r.failed ? ` · ${r.failed} failed` : ''}${r.queued ? ` · ${r.queued} waiting` : ''}` : ''}</p>
                  </div>
                  {manage && (
                    <div className="flex gap-2">
                      {(c.status === 'draft' || c.status === 'scheduled') && <Button size="sm" icon={<Send className="size-4" />} loading={send.isPending && send.variables === c.id} onClick={async () => { if (await confirm({ title: `Send “${c.name}” now?`, body: `About ${c.recipientsCount} customers will receive this ${NOTIFICATION_CHANNEL_LABELS[c.channel]} message. It cannot be recalled once sent.`, confirmLabel: 'Send now', cancelLabel: 'Not yet' })) send.mutate(c.id); }}>Send now</Button>}
                      {['draft', 'scheduled', 'sending'].includes(c.status) && <Button size="sm" variant="outline" icon={<XCircle className="size-4" />} onClick={async () => { if (await confirm({ title: `Cancel “${c.name}”?`, body: 'Messages that have not gone out yet are stopped. Messages already sent cannot be taken back.', confirmLabel: 'Cancel campaign', cancelLabel: 'Keep it', tone: 'danger' })) cancel.mutate(c.id); }}>Cancel</Button>}
                    </div>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {creating && <CampaignDrawer initialSegmentId={segmentParam} onClose={close} />}
    </div>
  );
}

function CampaignDrawer({ initialSegmentId, onClose }: { initialSegmentId: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const { timezone } = useBranch();
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<Segment[]>('/segments') });
  const summary = useQuery({ queryKey: ['notifications', 'summary'], queryFn: () => api.get<Summary>('/notifications/summary') });
  const connected = (summary.data?.connectedChannels ?? []) as NotificationChannel[];
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<NotificationChannel>('whatsapp');
  const [eventType, setEventType] = useState<'offer' | 're_engagement' | 'birthday'>('offer');
  const [segmentId, setSegmentId] = useState(initialSegmentId ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Hi {{customerName}}, ');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [date, setDate] = useState(todayIn(timezone));
  const [time, setTime] = useState('10:00');
  const [error, setError] = useState<string | null>(null);
  const segment = segments.data?.find((s) => s.id === segmentId);
  const filter: SegmentFilterInput = { ...(segment?.filter ?? {}), marketingConsentOnly: true };
  const debouncedFilter = useDebounced(filter, 300);
  const audience = useQuery({ queryKey: ['campaign-audience', channel, debouncedFilter], queryFn: () => api.post<{ recipients: number }>('/campaigns/audience', { channel, segmentFilter: debouncedFilter }), placeholderData: (p) => p });

  useEffect(() => { if (segment && !name) setName(`Message to ${segment.name}`); }, [segment, name]);
  useEffect(() => { if (connected.length && !connected.includes(channel)) setChannel(connected[0]!); }, [connected, channel]);

  const save = useMutation({
    mutationFn: () => {
      const parsed = campaignSchema.safeParse({ name, eventType, channel, segmentFilter: filter, subject: channel === 'email' ? subject : null, body, scheduledAt: when === 'later' ? toInstant(date, time, timezone) : null });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.path[0] === 'name' ? 'Give the campaign a name.' : parsed.error.issues[0]?.path[0] === 'body' ? 'Write the message (at least a few words).' : 'Please check the details.');
      return api.post<Campaign>('/campaigns', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['campaigns'] }); toast.success(when === 'later' ? 'Campaign scheduled' : 'Campaign saved. Review it and press Send now.'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  const insert = (v: string) => setBody((b) => `${b}{{${v}}}`);
  const noGroups = segments.data?.length === 0;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title="New campaign" size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={connected.length === 0} onClick={() => { setError(null); save.mutate(); }}>{when === 'later' ? 'Schedule campaign' : 'Save campaign'}</Button></>}>
      <div className="space-y-5">
        <FormError message={error} />
        {summary.data && connected.length === 0 && <InlineNotice tone="warning" title="No messaging channel is connected">Connect WhatsApp, email or SMS in Settings → Connections first.</InlineNotice>}
        <Field label="Campaign name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali offer" autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Send by"><Select value={channel} onChange={(e) => setChannel(e.target.value as NotificationChannel)}>{NOTIFICATION_CHANNELS.filter((c) => connected.includes(c)).map((c) => <option key={c} value={c}>{NOTIFICATION_CHANNEL_LABELS[c]}</option>)}</Select></Field>
          <Field label="Kind of message"><Select value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>{EVENTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</Select></Field>
        </div>
        <Field label="Who should get it?" hint={noGroups ? 'No saved groups yet. Everyone who agreed to offers will receive it, or create a group first.' : undefined}>
          <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}><option value="">Everyone who agreed to offers</option>{(segments.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.customerCount})</option>)}</Select>
        </Field>
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm" aria-live="polite"><span className="font-semibold">{audience.data ? audience.data.recipients : '…'}</span> {audience.data?.recipients === 1 ? 'customer' : 'customers'} will receive this by {NOTIFICATION_CHANNEL_LABELS[channel]}. <span className="text-muted">Customers without a {channel === 'email' ? 'email address' : 'mobile number'} or who have not agreed to offers are skipped.</span></p>
        {channel === 'email' && <Field label="Email subject" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
        <Field label="Message" required><Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Placeholders">
          {TEMPLATE_VARIABLES[eventType].filter((v) => v !== 'message').map((v) => <Button key={v} type="button" size="sm" variant="soft" onClick={() => insert(v)}>{VARIABLES[v] ?? v}</Button>)}
        </div>
        <div className="space-y-3">
          <Segmented label="When" value={when} onChange={setWhen} options={[{ value: 'now', label: 'Save, then send when I am ready' }, { value: 'later', label: 'Schedule for later' }]} />
          {when === 'later' && <div className="flex flex-wrap gap-3"><Field label="Date"><DateInput value={date} min={todayIn(timezone)} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Time"><TimeInput value={time} onChange={(e) => setTime(e.target.value)} /></Field></div>}
        </div>
        <InlineNotice tone="info">Promotional messages go only to customers who agreed to receive them, and never during the salon’s quiet hours.</InlineNotice>
      </div>
    </Drawer>
  );
}
