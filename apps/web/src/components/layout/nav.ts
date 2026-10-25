import type { Permission } from '@salon/shared';
import { BarChart3, Bell, Building2, CalendarDays, ClipboardList, DoorOpen, LayoutDashboard, ListChecks, Receipt, Scissors, Settings, ShieldCheck, Sparkles, Store, UserCog, Users, Wallet, type LucideIcon } from 'lucide-react';

// Sidebar structure from the product brief, written in the salon's own words. An item shows when the user has ANY of
// its permissions; the API enforces the same permissions, so hiding is only about keeping screens uncluttered.

export interface NavItem {
  label: string;
  to: string;
  icon?: LucideIcon;
  /** Needs any of these. */
  any?: Permission[];
  /** Needs none of these (e.g. the staff-only home). */
  unless?: Permission[];
  end?: boolean;
}
export interface NavGroup {
  label?: string;
  icon?: LucideIcon;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, any: ['dashboard.business'] },
      { label: 'Today at the salon', to: '/today', icon: ClipboardList, any: ['dashboard.branch'], unless: ['dashboard.business'] },
      { label: 'Front desk', to: '/desk', icon: Store, any: ['appointments.create', 'walkins.manage', 'billing.create'] },
      { label: 'My day', to: '/my-day', icon: CalendarDays, any: ['appointments.view_own'], unless: ['appointments.view'] },
    ],
  },
  {
    label: 'Appointments',
    icon: CalendarDays,
    items: [
      { label: 'Calendar', to: '/appointments/calendar', any: ['appointments.view'] },
      { label: 'Appointment list', to: '/appointments', any: ['appointments.view'], end: true },
      { label: 'Walk-ins', to: '/walk-ins', icon: DoorOpen, any: ['walkins.manage', 'appointments.view'] },
    ],
  },
  {
    label: 'Customers',
    icon: Users,
    items: [
      { label: 'Customer list', to: '/customers', any: ['customers.view'], end: true },
      { label: 'Customer groups', to: '/customers/segments', any: ['customers.view'] },
    ],
  },
  {
    label: 'Services',
    icon: Scissors,
    items: [
      { label: 'Services', to: '/services', any: ['services.view'], end: true },
      { label: 'Categories', to: '/services/categories', any: ['services.manage'] },
      { label: 'Expertise', to: '/services/expertise', any: ['services.manage'] },
      { label: 'Packages & combos', to: '/services/packages', any: ['packages.manage'] },
      { label: 'Offers', to: '/services/offers', any: ['offers.manage'] },
    ],
  },
  {
    label: 'Team',
    icon: UserCog,
    items: [
      { label: 'Team members', to: '/staff', any: ['staff.view'], end: true },
      { label: 'Schedules & leave', to: '/staff/schedule', any: ['staff.view'] },
      { label: 'Attendance', to: '/staff/attendance', any: ['attendance.view'] },
      { label: 'Assign services', to: '/staff/mapping', any: ['staff.manage'] },
    ],
  },
  {
    label: 'Billing',
    icon: Receipt,
    items: [
      { label: 'New bill', to: '/billing/new', icon: Sparkles, any: ['billing.create'] },
      { label: 'Bills', to: '/billing/bills', any: ['billing.view'] },
      { label: 'Collect payment', to: '/billing/collect', icon: Wallet, any: ['payments.collect'] },
      { label: 'Pending payments', to: '/billing/pending', any: ['ledger.view', 'reports.financial'] },
      { label: 'Payments received', to: '/billing/payments', any: ['billing.view', 'payments.collect'] },
      { label: 'Customer ledger', to: '/billing/ledger', any: ['ledger.view'] },
    ],
  },
  {
    items: [{ label: 'Reports', to: '/reports', icon: BarChart3, any: ['reports.operations', 'reports.financial', 'reports.staff', 'attendance.view'] }],
  },
  {
    label: 'Messages',
    icon: Bell,
    items: [
      { label: 'Message templates', to: '/notifications/templates', any: ['notifications.view', 'notifications.manage'] },
      { label: 'Campaigns', to: '/notifications/campaigns', any: ['campaigns.manage'] },
      { label: 'Delivery log', to: '/notifications/logs', any: ['notifications.view'] },
    ],
  },
  {
    label: 'Salon',
    icon: Building2,
    items: [
      { label: 'Branches', to: '/branches', icon: Building2, any: ['branches.manage'] },
      { label: 'Users & roles', to: '/users', icon: ShieldCheck, any: ['users.manage', 'roles.manage'] },
      { label: 'Activity log', to: '/activity', icon: ListChecks, any: ['audit.view'] },
      { label: 'Settings', to: '/settings', icon: Settings, any: ['settings.manage', 'integrations.manage'] },
    ],
  },
];

export function visibleNav(can: (p: Permission[]) => boolean): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (!i.any || can(i.any)) && (!i.unless || !can(i.unless))),
  })).filter((g) => g.items.length > 0);
}
