import { useQuery } from '@tanstack/react-query';
import { Building2, CalendarPlus, ChevronDown, ChevronRight, DoorOpen, Home, Keyboard, KeyRound, LogOut, Menu as MenuIcon, Moon, Plus, Receipt, Search, ShieldCheck, Store, Sun, UserPlus, Users, Wallet, X, CalendarDays } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet, useMatches, useNavigate } from 'react-router';
import { Button, ButtonLink, IconButton } from '@/components/ui/button';
import { Avatar, InlineNotice, Spinner } from '@/components/ui/display';
import { Menu } from '@/components/ui/overlay';
import { QuickActionsProvider, useQuickActions } from '@/features/quick/QuickActions';
import { api } from '@/lib/api';
import { useAuth, useCan, useUser } from '@/lib/auth';
import { BranchProvider, useBranch } from '@/lib/branch';
import { useHotkeys, useTheme } from '@/lib/hooks';
import { cn, initials } from '@/lib/utils';
import { GlobalSearch } from './GlobalSearch';
import { Sidebar, SidebarContent } from './Sidebar';

function Breadcrumbs() {
  const matches = useMatches() as Array<{ pathname: string; handle?: { crumb?: string } }>;
  const crumbs = matches.filter((m) => m.handle?.crumb).map((m) => ({ label: m.handle!.crumb!, to: m.pathname }));
  if (crumbs.length < 2) return <div className="min-w-0 truncate text-sm font-medium text-fg">{crumbs[0]?.label ?? ''}</div>;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 truncate text-sm">
        {crumbs.map((c, i) => (
          <li key={c.to} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-faint" aria-hidden />}
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="font-medium text-fg">{c.label}</span>
            ) : (
              <Link to={c.to} className="text-muted hover:text-fg">{c.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function BranchSelector() {
  const { branches, selection, setSelection, canChoose, branch } = useBranch();
  const user = useUser();
  if (!canChoose) {
    return (
      <span className="hidden items-center gap-1.5 text-sm text-muted md:inline-flex">
        <Building2 className="size-4" aria-hidden />
        {branch.name}
      </span>
    );
  }
  return (
    <Menu
      trigger={
        <Button variant="outline" size="sm" icon={<Building2 className="size-4" />}>
          <span className="max-w-32 truncate">{selection === 'all' ? 'All branches' : branch.name}</span>
          <span className="sr-only">, choose branch</span>
          <ChevronDown className="size-4" />
        </Button>
      }
      items={[
        ...(user.allBranches ? [{ label: 'All branches', onSelect: () => setSelection('all'), hint: selection === 'all' ? '✓' : undefined }] : []),
        ...branches.map((b) => ({ label: b.name, onSelect: () => setSelection(b.id), hint: selection === b.id ? '✓' : undefined })),
      ]}
    />
  );
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const rows: Array<[string, string]> = [['N', 'New appointment'], ['W', 'Walk-in'], ['C', 'Find a customer'], ['B', 'Create bill'], ['P', 'Collect payment'], ['/', 'Search anything'], ['Esc', 'Close this panel']];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-5 shadow-pop outline-none">
          <Dialog.Title className="mb-3 text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
          <dl className="space-y-2">
            {rows.map(([k, label]) => (
              <div key={k} className="flex items-center justify-between text-sm">
                <dt className="text-muted">{label}</dt>
                <dd><kbd className="rounded border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium">{k}</kbd></dd>
              </div>
            ))}
          </dl>
          <Dialog.Close asChild>
            <Button className="mt-4 w-full" variant="outline">Got it</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Topbar({ onOpenMenu, onSearch, onShortcuts }: { onOpenMenu: () => void; onSearch: () => void; onShortcuts: () => void }) {
  const user = useUser();
  const { logout } = useAuth();
  const can = useCan();
  const quick = useQuickActions();
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

  const newItems = [
    { label: 'New appointment', icon: <CalendarPlus className="size-4" />, onSelect: () => quick.newAppointment(), hidden: !can('appointments.create'), hint: 'N' },
    { label: 'Walk-in', icon: <DoorOpen className="size-4" />, onSelect: () => quick.walkIn(), hidden: !can('walkins.manage'), hint: 'W' },
    { label: 'Add customer', icon: <UserPlus className="size-4" />, onSelect: () => quick.newCustomer(), hidden: !can('customers.create') },
    { label: 'Create bill', icon: <Receipt className="size-4" />, onSelect: () => navigate('/billing/new'), hidden: !can('billing.create'), hint: 'B' },
    { label: 'Collect payment', icon: <Wallet className="size-4" />, onSelect: () => navigate('/billing/collect'), hidden: !can('payments.collect'), hint: 'P' },
  ];

  return (
    <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur md:px-5">
      <IconButton label="Open menu" className="lg:hidden" onClick={onOpenMenu}>
        <MenuIcon className="size-5" />
      </IconButton>
      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>
      {can(['customers.view', 'appointments.view', 'billing.view']) && (
        <button type="button" onClick={onSearch} className="hidden h-9 w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm text-muted hover:border-line-strong md:flex">
          <Search className="size-4" />
          <span className="flex-1 text-left">Find a customer…</span>
          <kbd className="rounded border border-line px-1.5 text-[11px]">/</kbd>
        </button>
      )}
      <IconButton label="Search" className="md:hidden" onClick={onSearch}>
        <Search className="size-5" />
      </IconButton>
      {can('appointments.create') && (
        <Button size="sm" className="hidden lg:inline-flex" icon={<CalendarPlus className="size-4" />} hotkey="N" onClick={() => quick.newAppointment()}>
          New appointment
        </Button>
      )}
      {can('walkins.manage') && (
        <Button size="sm" variant="outline" className="hidden xl:inline-flex" icon={<DoorOpen className="size-4" />} hotkey="W" onClick={() => quick.walkIn()}>
          Walk-in
        </Button>
      )}
      {newItems.some((i) => !i.hidden) && (
        <Menu label="New…" trigger={<IconButton label="New…" variant="soft"><Plus className="size-5" /></IconButton>} items={newItems} />
      )}
      <BranchSelector />
      <Menu
        label="Account"
        trigger={
          <button type="button" aria-label={`${initials(user.fullName)} account menu`} className="rounded-full">
            <Avatar name={user.fullName} />
          </button>
        }
        items={[
          { label: <span><span className="block font-medium">{user.fullName}</span><span className="block text-xs text-muted">{user.email ?? user.phone}</span></span>, onSelect: () => undefined, disabled: true },
          'separator',
          { label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />, onSelect: toggleTheme },
          { label: 'Keyboard shortcuts', icon: <Keyboard className="size-4" />, onSelect: onShortcuts },
          { label: 'Change password', icon: <KeyRound className="size-4" />, onSelect: () => navigate('/change-password') },
          { label: 'Account security', icon: <ShieldCheck className="size-4" />, onSelect: () => navigate('/security') },
          'separator',
          { label: 'Sign out', icon: <LogOut className="size-4" />, tone: 'danger', onSelect: () => void logout() },
        ]}
      />
    </header>
  );
}

function MobileBottomNav({ onMore }: { onMore: () => void }) {
  const can = useCan();
  const quick = useQuickActions();
  const staffOnly = can('appointments.view_own') && !can('appointments.view');
  if (staffOnly) return null;
  const item = 'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium';
  return (
    <nav aria-label="Quick navigation" className="no-print fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <NavLink to="/desk" className={({ isActive }) => cn(item, isActive ? 'text-primary' : 'text-muted')}>
        <Store className="size-5" aria-hidden />
        Desk
      </NavLink>
      <NavLink to="/appointments/calendar" className={({ isActive }) => cn(item, isActive ? 'text-primary' : 'text-muted')}>
        <CalendarDays className="size-5" aria-hidden />
        Calendar
      </NavLink>
      {can('appointments.create') ? (
        <button type="button" onClick={() => quick.newAppointment()} className={cn(item, 'text-primary')} aria-label="New appointment">
          <span className="-mt-5 grid size-12 place-items-center rounded-full bg-primary text-primary-fg shadow-pop">
            <Plus className="size-6" />
          </span>
          New
        </button>
      ) : null}
      <NavLink to="/customers" className={({ isActive }) => cn(item, isActive ? 'text-primary' : 'text-muted')}>
        <Users className="size-5" aria-hidden />
        Customers
      </NavLink>
      <button type="button" onClick={onMore} className={cn(item, 'text-muted')}>
        <MenuIcon className="size-5" aria-hidden />
        More
      </button>
    </nav>
  );
}

function OnboardingBanner() {
  const can = useCan();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('salonos:onboarding-dismissed') === '1');
  const { data } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<{ completed: number; total: number; completedAt: string | null }>('/organization/onboarding'),
    enabled: can('settings.manage') && !dismissed,
    staleTime: 60_000,
  });
  if (!data || data.completedAt || dismissed || data.completed >= data.total) return null;
  return (
    <div className="mb-4">
      <InlineNotice
        tone="info"
        title={`Finish setting up your salon: ${data.completed} of ${data.total} done`}
        action={
          <div className="flex gap-2">
            <ButtonLink to="/settings/setup" size="sm">Continue setup</ButtonLink>
            <button type="button" aria-label="Hide for now" className="grid size-8 place-items-center rounded-lg hover:bg-black/5" onClick={() => { sessionStorage.setItem('salonos:onboarding-dismissed', '1'); setDismissed(true); }}>
              <X className="size-4" />
            </button>
          </div>
        }
      >
        You can skip steps and come back to them later.
      </InlineNotice>
    </div>
  );
}

function Shell() {
  const can = useCan();
  const quick = useQuickActions();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);

  useHotkeys({
    n: () => can('appointments.create') && quick.newAppointment(),
    w: () => can('walkins.manage') && quick.walkIn(),
    c: () => can('customers.view') && setSearchOpen(true),
    b: () => can('billing.create') && navigate('/billing/new'),
    p: () => can('payments.collect') && navigate('/billing/collect'),
    '/': () => setSearchOpen(true),
    '?': () => setShortcuts(true),
  });

  return (
    <div className="min-h-dvh lg:flex">
      <a href="#main" className="no-print sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg">
        Skip to main content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMenu={() => setMenuOpen(true)} onSearch={() => setSearchOpen(true)} onShortcuts={() => setShortcuts(true)} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-3 py-4 pb-24 outline-none md:px-6 md:py-6 lg:pb-8">
          <OnboardingBanner />
          <Suspense fallback={<Spinner label="Loading…" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <MobileBottomNav onMore={() => setMenuOpen(true)} />
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 lg:hidden" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-surface shadow-pop outline-none lg:hidden">
            <Dialog.Title className="sr-only">Menu</Dialog.Title>
            <SidebarContent onNavigate={() => setMenuOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </div>
  );
}

export function AppShell() {
  const user = useUser();
  // Platform administrators have no salon, and anyone who still has to set up two-step sign-in can reach nothing but that
  // screen: both get the plain shell without branch/quick-action context.
  if (user.isPlatformAdmin || user.twoFactor.setupRequired) {
    return (
      <BranchProvider>
        <QuickActionsProvider>
          <PlatformShell />
        </QuickActionsProvider>
      </BranchProvider>
    );
  }
  return (
    <BranchProvider>
      <QuickActionsProvider>
        <Shell />
      </QuickActionsProvider>
    </BranchProvider>
  );
}

function PlatformShell() {
  const { logout } = useAuth();
  const user = useUser();
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4 md:px-6">
        <Link to={user.isPlatformAdmin ? '/platform' : '/security'} className="flex items-center gap-2 font-semibold">
          <Home className="size-5 text-primary" aria-hidden /> {user.isPlatformAdmin ? 'SalonOS platform' : 'SalonOS'}
        </Link>
        <div className="flex items-center gap-3 text-sm text-muted">
          {user.isPlatformAdmin && <Link to="/security" className="font-medium text-primary hover:underline">Account security</Link>}
          {user.fullName}
          <Button variant="outline" size="sm" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
