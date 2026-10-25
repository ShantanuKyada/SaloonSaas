import type { ServiceDto } from '@salon/shared';
import { Check, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SearchInput } from '@/components/ui/form';
import { fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMoney } from './badges';

/**
 * Pick one or more services. The customer's usual services and the most-booked ones come first, so most bookings are
 * two taps; search and categories are there for everything else.
 */
export function ServicePicker({ services, selected, onToggle, usualIds = [], multiple = true, maxHeight = 'max-h-72' }: { services: ServiceDto[]; selected: string[]; onToggle: (id: string) => void; usualIds?: string[]; multiple?: boolean; maxHeight?: string }) {
  const money = useMoney();
  const [text, setText] = useState('');
  const q = text.trim().toLowerCase();
  const popular = useMemo(() => [...services].sort((a, b) => (b.bookingsLast30Days ?? 0) - (a.bookingsLast30Days ?? 0)).slice(0, 6), [services]);
  const usual = services.filter((s) => usualIds.includes(s.id));
  const filtered = services.filter((s) => !q || s.name.toLowerCase().includes(q) || s.categoryName.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
  const groups = useMemo(() => {
    const map = new Map<string, ServiceDto[]>();
    for (const s of filtered) map.set(s.categoryName, [...(map.get(s.categoryName) ?? []), s]);
    return [...map.entries()];
  }, [filtered]);

  const chip = (s: ServiceDto) => {
    const on = selected.includes(s.id);
    return (
      <button key={s.id} type="button" aria-pressed={on} onClick={() => onToggle(s.id)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors max-md:min-h-10', on ? 'border-primary bg-primary-soft text-primary-soft-fg' : 'border-line bg-surface text-fg hover:border-primary/50')}>
        {on ? <Check className="size-3.5" aria-hidden /> : <Plus className="size-3.5 text-muted" aria-hidden />}
        {s.name}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {!q && usual.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Usual for this customer</p>
          <div className="flex flex-wrap gap-2">{usual.map(chip)}</div>
        </div>
      )}
      {!q && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Most booked</p>
          <div className="flex flex-wrap gap-2">{popular.map(chip)}</div>
        </div>
      )}
      <SearchInput value={text} onChange={setText} placeholder="Search all services" aria-label="Search services" />
      <div className={cn('scroll-thin overflow-y-auto rounded-xl border border-line', maxHeight)}>
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">No service matches “{text}”.</p>
        ) : (
          groups.map(([category, items]) => (
            <div key={category}>
              <p className="sticky top-0 bg-surface-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{category}</p>
              <ul>
                {items.map((s) => {
                  const on = selected.includes(s.id);
                  return (
                    <li key={s.id}>
                      <button type="button" onClick={() => onToggle(s.id)} role={multiple ? 'checkbox' : 'radio'} aria-checked={on} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 max-md:min-h-12">
                        <span className={cn('grid size-5 shrink-0 place-items-center rounded border', on ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong')}>{on && <Check className="size-3.5" strokeWidth={3} />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">{s.name}</span>
                          <span className="block text-xs text-muted">{fmtDuration(s.durationMinutes)}</span>
                        </span>
                        <span className="text-sm tabular-nums text-fg">{money(s.price)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
