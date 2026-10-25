import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, SearchX } from 'lucide-react';
import { Tabs as RxTabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn, initials, readableOn } from '@/lib/utils';
import { deltaPercent } from '@/lib/format';
import { friendlyError } from '@/lib/errors';
import { Button } from './button';

// ───────────── Cards and layout ─────────────
export function Card({ className, children, padded = true, ...props }: React.HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div className={cn('rounded-card border border-line bg-surface shadow-card', padded && 'p-4 md:p-5', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-start justify-between gap-2', className)}>
      <div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight text-fg max-md:text-xl">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-line', className)} />;
}

// ───────────── Badges ─────────────
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-muted',
  primary: 'bg-primary-soft text-primary-soft-fg',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Avatar({ name, color, src, size = 'md' }: { name: string; color?: string | null; src?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const dim = { sm: 'size-7 text-[10px]', md: 'size-9 text-xs', lg: 'size-12 text-sm' }[size];
  if (src) return <img src={src} alt="" className={cn('shrink-0 rounded-full object-cover', dim)} />;
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full font-semibold', dim)} style={{ background: color ?? 'var(--primary)', color: readableOn(color) }}>
      {initials(name)}
    </span>
  );
}

// ───────────── Numbers ─────────────
export function StatCard({ label, value, previous, hint, icon, loading, tone = 'neutral', invertDelta, onClick, format }: { label: ReactNode; value: ReactNode; previous?: { current: number; before: number | null }; hint?: ReactNode; icon?: ReactNode; loading?: boolean; tone?: Tone; invertDelta?: boolean; onClick?: () => void; format?: (n: number) => string }) {
  const delta = previous ? deltaPercent(previous.current, previous.before) : null;
  const good = delta === null ? null : invertDelta ? delta <= 0 : delta >= 0;
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper onClick={onClick} className={cn('rounded-card border border-line bg-surface p-4 text-left shadow-card', onClick && 'transition-colors hover:border-primary/50')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted">{label}</span>
        {icon && <span className={cn('grid size-8 place-items-center rounded-lg', tones[tone])}>{icon}</span>}
      </div>
      {loading ? <div className="skeleton mt-2 h-8 w-28" /> : <div className="mt-1 text-2xl font-semibold tracking-tight text-fg tabular-nums max-md:text-xl">{value}</div>}
      <div className="mt-1 flex min-h-5 items-center gap-2 text-xs text-muted">
        {delta !== null && (
          <span className={cn('inline-flex items-center gap-0.5 font-medium', good ? 'text-success' : 'text-danger')}>
            {delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {Math.abs(delta)}%
          </span>
        )}
        {previous && delta !== null && <span>vs before{format ? ` (${format(previous.before ?? 0)})` : ''}</span>}
        {hint}
      </div>
    </Wrapper>
  );
}

// ───────────── Loading / empty / error ─────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden />;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function LoadingBlock({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 p-4">
      <p className="text-sm text-muted">{label}</p>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted">{icon ?? <SearchX className="size-6" />}</div>
      <div>
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** What happened, why, and what to do next. */
export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const e = friendlyError(error);
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-3 text-center', compact ? 'px-4 py-6' : 'px-6 py-12')}>
      <div className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="size-6" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-fg">{e.title}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{e.message}</p>
        {e.hints.length > 0 && <p className="mx-auto mt-2 max-w-md text-sm text-muted">{e.hints.join(' · ')}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineNotice({ tone = 'info', title, children, action }: { tone?: Exclude<Tone, 'neutral' | 'primary'>; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex flex-wrap items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-sm', tones[tone])}>
      <div>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5 opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

// ───────────── Tabs ─────────────
export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: Array<{ value: string; label: ReactNode; badge?: ReactNode }>; children?: ReactNode }) {
  return (
    <RxTabs.Root value={value} onValueChange={onValueChange}>
      <RxTabs.List className="scroll-thin mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Sections">
        {tabs.map((t) => (
          <RxTabs.Trigger key={t.value} value={t.value} className="relative -mb-px flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium text-muted outline-none transition-colors hover:text-fg data-[state=active]:border-primary data-[state=active]:text-fg max-md:min-h-11">
            {t.label}
            {t.badge}
          </RxTabs.Trigger>
        ))}
      </RxTabs.List>
      {children}
    </RxTabs.Root>
  );
}
export const TabPanel = RxTabs.Content;

export function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="hidden rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted lg:inline">{children}</kbd>;
}

export function Meter({ value, max, tone = 'primary', label }: { value: number; max: number; tone?: 'primary' | 'success' | 'warning' | 'danger'; label?: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' }[tone];
  return (
    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label} className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cn('h-full rounded-full transition-all', bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}
