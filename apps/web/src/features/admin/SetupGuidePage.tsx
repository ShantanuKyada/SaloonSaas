import { ONBOARDING_STEP_LABELS, type OnboardingStep } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, PartyPopper } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { Button, ButtonLink } from '@/components/ui/button';
import { Badge, Card, ErrorState, Meter, PageHeader, Skeleton } from '@/components/ui/display';
import { api } from '@/lib/api';
import { homePath, useAuth, useUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface Onboarding { steps: Array<{ step: OnboardingStep; status: 'done' | 'skipped' | 'pending' }>; completed: number; total: number; completedAt: string | null; counts: { branches: number; services: number; staff: number; mappings: number; shifts: number; messaging: number } }

const GUIDE: Record<OnboardingStep, { text: string; to: string; action: string; count?: (c: Onboarding['counts']) => string }> = {
  salon: { text: 'Add your salon’s name, address and tax details. They appear on bills and receipts.', to: '/settings?tab=salon', action: 'Open salon details' },
  branches: { text: 'Check your branch address and set opening hours. Add more branches if you have them.', to: '/branches', action: 'Open branches', count: (c) => `${c.branches} ${c.branches === 1 ? 'branch' : 'branches'}` },
  services: { text: 'List what you offer with price and time. Group services into categories like Hair or Skin.', to: '/services', action: 'Add services', count: (c) => `${c.services} ${c.services === 1 ? 'service' : 'services'}` },
  staff: { text: 'Add your stylists and therapists so they can be booked.', to: '/staff', action: 'Add team members', count: (c) => `${c.staff} on the team` },
  expertise: { text: 'Choose who can do which service. Booking only offers people who are ticked.', to: '/staff/mapping', action: 'Assign services', count: (c) => `${c.mappings} assignments` },
  hours: { text: 'Set each person’s weekly hours, breaks and days off.', to: '/staff/schedule', action: 'Set working hours', count: (c) => `${c.shifts} shifts set` },
  messaging: { text: 'Connect WhatsApp, email or SMS so customers get confirmations and reminders. You can do this later.', to: '/settings?tab=connections', action: 'Connect messaging', count: (c) => `${c.messaging} connected` },
  ready: { text: 'Everything above is optional to finish, but you are ready to take bookings as soon as services, team and hours exist.', to: '/appointments/calendar', action: 'Open the calendar' },
};

/** A friendly checklist for a new salon. Each step opens the real screen; ticks appear as soon as the work is done. */
export function Component() {
  const user = useUser();
  const { reloadUser } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['onboarding'], queryFn: () => api.get<Onboarding>('/organization/onboarding') });
  const mark = useMutation({
    mutationFn: ({ step, status }: { step: OnboardingStep; status: 'done' | 'skipped' }) => api.post('/organization/onboarding/step', { step, status }),
    onSuccess: async (_d, v) => {
      await client.invalidateQueries({ queryKey: ['onboarding'] });
      if (v.step === 'ready') { await reloadUser(); toast.success('You are all set. Welcome aboard!'); void navigate(homePath(user)); }
    },
    onError: toastError,
  });

  if (q.isLoading) return <div role="status" aria-label="Loading setup guide" className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-24" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const firstPending = d.steps.find((s) => s.status === 'pending' && s.step !== 'ready')?.step;
  const allBeforeReady = d.steps.filter((s) => s.step !== 'ready').every((s) => s.status !== 'pending');

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Set up your salon" description="Work through these in any order. Ticks appear by themselves once the work is done." />
      <Card>
        <div className="flex items-center justify-between gap-3"><p className="font-semibold">{d.completedAt ? 'Setup complete' : `${d.completed} of ${d.total} steps done`}</p>{d.completedAt && <PartyPopper className="size-5 text-success" aria-hidden />}</div>
        <div className="mt-3"><Meter value={d.completed} max={d.total} tone={d.completed === d.total ? 'success' : 'primary'} label={`${d.completed} of ${d.total} steps done`} /></div>
      </Card>
      <ol className="space-y-3">
        {d.steps.map((s, i) => {
          const g = GUIDE[s.step];
          const done = s.status === 'done';
          const isReady = s.step === 'ready';
          return (
            <li key={s.step}>
              <Card className={cn(s.step === firstPending && 'ring-2 ring-primary/40')}>
                <div className="flex items-start gap-3">
                  <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-sm', done ? 'border-success bg-success text-white' : s.status === 'skipped' ? 'border-line bg-surface-2 text-muted' : 'border-line')} aria-hidden>{done ? <Check className="size-4" /> : s.status === 'skipped' ? <Circle className="size-3" /> : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{ONBOARDING_STEP_LABELS[s.step]}</h2>{done && <Badge tone="success">Done</Badge>}{s.status === 'skipped' && <Badge>Skipped for now</Badge>}{g.count && <span className="text-sm text-muted">{g.count(d.counts)}</span>}</div>
                    <p className="mt-1 text-sm text-muted">{g.text}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {isReady ? (
                        <>
                          {!d.completedAt && <Button loading={mark.isPending} disabled={!allBeforeReady} onClick={() => mark.mutate({ step: 'ready', status: 'done' })}>Finish setup</Button>}
                          <ButtonLink to={g.to} variant="outline">{g.action}</ButtonLink>
                          {!allBeforeReady && !d.completedAt && <p className="self-center text-xs text-muted">Finish or skip the steps above first.</p>}
                        </>
                      ) : (
                        <>
                          <ButtonLink to={g.to} variant={done ? 'outline' : 'primary'} icon={<ArrowRight className="size-4" />}>{done ? 'Review' : g.action}</ButtonLink>
                          {s.status === 'pending' && <Button variant="ghost" loading={mark.isPending && mark.variables?.step === s.step} onClick={() => mark.mutate({ step: s.step, status: 'skipped' })}>Skip for now</Button>}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
      <p className="text-center text-sm text-muted">You can come back to this guide any time from <Link className="font-medium text-primary hover:underline" to="/settings">Settings</Link>.</p>
    </div>
  );
}
