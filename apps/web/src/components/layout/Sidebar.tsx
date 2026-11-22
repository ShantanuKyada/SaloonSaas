import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useCan, useFeature, useUser } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { visibleNav, type NavGroup } from './nav';

const isActive = (group: NavGroup, pathname: string) => group.items.some((i) => (i.end ? pathname === i.to : pathname.startsWith(i.to)));

function Group({ group, open, onToggle, onNavigate }: { group: NavGroup; open: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = isActive(group, pathname);
  const Icon = group.icon;
  if (!group.label) {
    return (
      <ul className="space-y-0.5">
        {group.items.map((item) => (
          <li key={item.to}>
            <Item item={item} onNavigate={onNavigate} top />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={onToggle} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-2 max-lg:min-h-11', active ? 'text-fg' : 'text-muted')}>
        {Icon && <Icon className="size-[18px]" aria-hidden />}
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="ml-[22px] mt-0.5 space-y-0.5 border-l border-line pl-3">
          {group.items.map((item) => (
            <li key={item.to}>
              <Item item={item} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({ item, onNavigate, top }: { item: NavGroup['items'][number]; onNavigate?: () => void; top?: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors max-lg:min-h-11', top && 'font-medium', isActive ? 'bg-primary-soft font-medium text-primary-soft-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
    >
      {top && Icon && <Icon className="size-[18px]" aria-hidden />}
      {item.label}
    </NavLink>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const can = useCan();
  const user = useUser();
  const featureOn = useFeature();
  const groups = visibleNav((p) => can(p), featureOn);
  // One menu open at a time: opening another closes it. The menu holding the current page opens when you arrive there.
  const { pathname } = useLocation();
  const current = groups.find((g) => g.label && isActive(g, pathname))?.label ?? null;
  const [openLabel, setOpenLabel] = useState<string | null>(current);
  useEffect(() => setOpenLabel(current), [current]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-fg" aria-hidden>
          <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <circle cx="12" cy="7" r="3" />
            <path d="M5 20c0-4 3-7 7-9 4 2 7 5 7 9-2-1-4.500-1.500-7-1.500S7 19 5 20Z" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{user.organization?.name ?? 'SalonOS'}</p>
          <p className="truncate text-xs text-muted">{user.role?.name ?? 'Platform'}</p>
        </div>
      </div>
      <nav aria-label="Main" className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {groups.map((g, i) => (
          <Group key={g.label ?? `top-${i}`} group={g} open={!!g.label && openLabel === g.label} onToggle={() => setOpenLabel((o) => (o === g.label ? null : (g.label ?? null)))} onNavigate={onNavigate} />
        ))}
      </nav>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-line bg-surface lg:block">
      <SidebarContent />
    </aside>
  );
}
