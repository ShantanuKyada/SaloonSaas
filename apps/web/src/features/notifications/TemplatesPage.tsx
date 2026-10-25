import { NOTIFICATION_CHANNEL_LABELS, type NotificationChannel } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, FormError, Input, Switch, Textarea } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { useDebounced } from '@/lib/hooks';

interface Template { id: string; eventType: string; eventLabel: string; channel: NotificationChannel; name: string; subject: string | null; body: string; isActive: boolean; providerTemplateName: string | null; variables: string[] }
interface Preview { body: string; subject: string | null; unknownPlaceholders: string[] }

const VARIABLE_LABEL: Record<string, string> = {
  customerName: 'Customer name', salonName: 'Salon name', branchName: 'Branch', services: 'Services', date: 'Date', time: 'Time', staff: 'Team member', bookingNumber: 'Booking number', branchPhone: 'Branch phone', manageLink: 'Manage link', amount: 'Amount', receiptNumber: 'Receipt number', method: 'Payment method', balance: 'Balance', message: 'Your message', daysSinceLastVisit: 'Days since last visit',
};

/** The words behind every automatic message. Staff see the sample result as they type, so nothing goes out untested. */
export function Component() {
  const manage = useCan()('notifications.manage');
  const [editing, setEditing] = useState<Template | null>(null);
  const q = useQuery({ queryKey: ['notification-templates'], queryFn: () => api.get<Template[]>('/notification-templates') });
  const groups = useMemo(() => {
    const m = new Map<string, Template[]>();
    for (const t of q.data ?? []) m.set(t.eventLabel, [...(m.get(t.eventLabel) ?? []), t]);
    return [...m.entries()];
  }, [q.data]);
  return (
    <div>
      <PageHeader title="Message templates" description="The wording of confirmations, reminders and receipts. Use the placeholders to add each customer’s details." />
      {q.isLoading && <div role="status" aria-label="Loading templates" className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.length === 0 && <Card><EmptyState title="No templates" description="Templates are created automatically when the salon is set up." /></Card>}
      <div className="space-y-4">
        {groups.map(([label, items]) => (
          <Card key={label} padded={false}>
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">{label}</h2>
            <ul className="divide-y divide-line">
              {items.map((t) => (
                <li key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="mb-1 flex items-center gap-2"><Badge tone="primary">{NOTIFICATION_CHANNEL_LABELS[t.channel]}</Badge>{!t.isActive && <Badge>Switched off</Badge>}</div>
                    <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted">{t.body}</p>
                  </div>
                  {manage && <Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(t)}>Edit</Button>}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      {editing && <TemplateDrawer template={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateDrawer({ template, onClose }: { template: Template; onClose: () => void }) {
  const client = useQueryClient();
  const [subject, setSubject] = useState(template.subject ?? '');
  const [body, setBody] = useState(template.body);
  const [active, setActive] = useState(template.isActive);
  const [providerName, setProviderName] = useState(template.providerTemplateName ?? '');
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const debounced = useDebounced({ body, subject }, 300);
  const preview = useQuery({ queryKey: ['template-preview', template.eventType, debounced], queryFn: () => api.post<Preview>('/notification-templates/preview', { eventType: template.eventType, body: debounced.body, subject: debounced.subject || null }), enabled: debounced.body.length > 0, placeholderData: (p) => p });
  const save = useMutation({
    mutationFn: () => api.put(`/notification-templates/${template.id}`, { subject: subject || null, body, isActive: active, providerTemplateName: providerName || null }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['notification-templates'] }); toast.success('Template saved'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? friendlyError(e).message : 'We could not save this template. Please try again.'),
  });
  const insert = (name: string) => {
    const el = area.current;
    const token = `{{${name}}}`;
    if (!el) { setBody((b) => `${b}${token}`); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };
  const unknown = preview.data?.unknownPlaceholders ?? [];

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${template.eventLabel} · ${NOTIFICATION_CHANNEL_LABELS[template.channel]}`} size="lg" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={body.trim().length === 0 || unknown.length > 0} loading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>Save template</Button></>}>
      <div className="space-y-5">
        <FormError message={error} />
        <Switch checked={active} onCheckedChange={setActive} label="Send this message" description="Switch off to stop this message going out." />
        {template.channel === 'email' && <Field label="Email subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
        <Field label="Message" required hint="Tap a placeholder to add it where your cursor is.">
          <Textarea ref={area} rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Placeholders">
          {template.variables.map((v) => <Button key={v} type="button" size="sm" variant="soft" onClick={() => insert(v)}>{VARIABLE_LABEL[v] ?? v}</Button>)}
        </div>
        {unknown.length > 0 && <InlineNotice tone="danger" title="Unknown placeholder">{unknown.map((u) => `{{${u}}}`).join(', ')} cannot be used in this message. Remove it or pick one from the list above.</InlineNotice>}
        {template.channel === 'whatsapp' && <Field label="WhatsApp approved template name" optional hint="WhatsApp requires pre-approved templates for business-started messages. Enter the name exactly as approved by Meta."><Input value={providerName} onChange={(e) => setProviderName(e.target.value)} /></Field>}
        <div>
          <p className="mb-1.5 text-sm font-medium">What the customer sees (sample data)</p>
          <div aria-live="polite" className="rounded-2xl rounded-tl-sm bg-primary-soft p-4 text-sm text-primary-soft-fg">
            {preview.data?.subject && <p className="mb-1 font-semibold">{preview.data.subject}</p>}
            <p className="whitespace-pre-wrap">{preview.data?.body ?? '…'}</p>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
