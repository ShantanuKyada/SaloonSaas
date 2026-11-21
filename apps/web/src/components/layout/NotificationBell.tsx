import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CalendarClock, CalendarPlus, CalendarX, MessageSquareReply, Palmtree, UserMinus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { IconButton } from '@/components/ui/button';
import { Popover } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useBranch } from '@/lib/branch';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

type Kind = 'booking_new' | 'booking_moved' | 'booking_removed' | 'booking_cancelled' | 'request_answered' | 'leave_answered';

interface StaffNotification {
  id: string;
  kind: Kind;
  title: string;
  body: string | null;
  link: string | null;
  appointmentId: string | null;
  readAt: string | null;
  createdAt: string;
}

const ICONS: Record<Kind, ReactNode> = {
  booking_new: <CalendarPlus className="size-4" />,
  booking_moved: <CalendarClock className="size-4" />,
  booking_removed: <UserMinus className="size-4" />,
  booking_cancelled: <CalendarX className="size-4" />,
  request_answered: <MessageSquareReply className="size-4" />,
  leave_answered: <Palmtree className="size-4" />,
};

const TONE: Record<Kind, string> = {
  booking_new: 'bg-primary-soft text-primary-soft-fg',
  booking_moved: 'bg-info-soft text-info',
  booking_removed: 'bg-surface-2 text-muted',
  booking_cancelled: 'bg-danger-soft text-danger',
  request_answered: 'bg-success-soft text-success',
  leave_answered: 'bg-warning-soft text-warning',
};

/** Pages that show a team member's own bookings, refreshed when something new arrives. */
const MY_QUERIES = ['my-appointments', 'my-day', 'my-schedule', 'my-change-requests', 'my-leaves'];

/** The team member's bell: new bookings for them, moves, cancellations and answers to their requests. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const { timezone: tz } = useBranch();
  const feed = useQuery({
    queryKey: ['my-notifications'],
    queryFn: () => api.get<{ unread: number; items: StaffNotification[] }>('/me/notifications'),
    refetchInterval: 60_000,
  });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post<{ marked: number }>('/me/notifications/read', ids ? { ids } : {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ['my-notifications'] }),
  });

  // When a new notice arrives, the lists behind it are out of date too.
  const newest = feed.data?.items[0]?.id;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!newest) return;
    if (seen.current && seen.current !== newest) for (const key of MY_QUERIES) void client.invalidateQueries({ queryKey: [key] });
    seen.current = newest;
  }, [newest, client]);

  const unread = feed.data?.unread ?? 0;
  const items = feed.data?.items ?? [];

  const openItem = (n: StaffNotification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Notifications"
      className="w-[min(24rem,calc(100vw-1.5rem))] p-0"
      trigger={
        <IconButton label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className="relative">
          <Bell className="size-5" />
          {unread > 0 && (
            <span aria-hidden className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-surface">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </IconButton>
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Notifications</h2>
        {unread > 0 && (
          <button type="button" className="text-xs font-medium text-primary hover:underline disabled:opacity-60" disabled={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
            Mark all as read
          </button>
        )}
      </div>
      {feed.isPending ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Loading…</p>
      ) : feed.isError ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Could not load your notifications. They will try again in a minute.</p>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">Nothing yet</p>
          <p className="mt-1 text-sm text-muted">New bookings for you, changes to them and answers to your requests show up here.</p>
        </div>
      ) : (
        <ul className="max-h-[min(28rem,70vh)] divide-y divide-line overflow-y-auto">
          {items.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => openItem(n)} className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none', !n.readAt && 'bg-primary-soft/40')}>
                <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', TONE[n.kind])}>{ICONS[n.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm text-fg', !n.readAt ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
                  <span className="mt-1 block text-xs text-faint">{timeAgo(n.createdAt, tz)}</span>
                </span>
                {!n.readAt && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line px-4 py-2.5 text-center">
        <Link to="/my-appointments" onClick={() => setOpen(false)} className="text-sm font-medium text-primary hover:underline">
          See my appointments
        </Link>
      </div>
    </Popover>
  );
}
