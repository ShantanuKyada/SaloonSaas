import type { HomeScreen, TwoFactorRequirement } from './constants.js';

// The permission catalogue. The API enforces these keys; the database `permissions` table is synced from this list
// on every migration run so roles can only reference permissions that exist in code.

interface PermissionDef {
  module: string;
  label: string;
}

export const PERMISSIONS = {
  'dashboard.business': { module: 'Dashboards', label: 'See business dashboard (revenue, branches, trends)' },
  'dashboard.branch': { module: 'Dashboards', label: 'See branch dashboard (salon right now)' },

  'appointments.view': { module: 'Appointments', label: 'See all appointments' },
  'appointments.view_own': { module: 'Appointments', label: 'See own appointments only' },
  'appointments.create': { module: 'Appointments', label: 'Book appointments' },
  'appointments.update': { module: 'Appointments', label: 'Move, edit and reassign appointments' },
  'appointments.status': { module: 'Appointments', label: 'Check in, start and complete services' },
  'appointments.cancel': { module: 'Appointments', label: 'Cancel appointments and mark no-shows' },
  'appointments.override_hours': { module: 'Appointments', label: 'Book outside working hours' },
  'walkins.manage': { module: 'Appointments', label: 'Manage walk-in queue' },

  'customers.view': { module: 'Customers', label: 'See customers' },
  'customers.view_contact': { module: 'Customers', label: 'See customer phone numbers and emails' },
  'customers.create': { module: 'Customers', label: 'Add customers' },
  'customers.update': { module: 'Customers', label: 'Edit customers' },
  'customers.archive': { module: 'Customers', label: 'Archive customers' },
  'customers.export': { module: 'Customers', label: 'Export customer lists' },

  'services.view': { module: 'Services', label: 'See services and prices' },
  'services.manage': { module: 'Services', label: 'Manage services, categories and expertise' },
  'offers.manage': { module: 'Services', label: 'Manage offers' },
  'packages.manage': { module: 'Services', label: 'Manage packages' },

  'staff.view': { module: 'Staff', label: 'See staff' },
  'staff.manage': { module: 'Staff', label: 'Add and edit staff' },
  'staff.schedule': { module: 'Staff', label: 'Manage staff schedules, leave and blocked time' },
  'staff.performance': { module: 'Staff', label: 'See staff performance' },
  'attendance.view': { module: 'Staff', label: 'See attendance' },
  'attendance.manage': { module: 'Staff', label: 'Correct attendance and manage devices' },

  'billing.view': { module: 'Billing', label: 'See bills' },
  'billing.create': { module: 'Billing', label: 'Create bills' },
  'billing.discount': { module: 'Billing', label: 'Give manual discounts' },
  'billing.void': { module: 'Billing', label: 'Cancel bills' },
  'billing.override_credit_limit': { module: 'Billing', label: 'Allow bills above credit limit' },
  'payments.collect': { module: 'Billing', label: 'Collect payments' },
  'payments.void': { module: 'Billing', label: 'Cancel payments' },
  'payments.refund': { module: 'Billing', label: 'Refund payments' },
  'ledger.view': { module: 'Billing', label: 'See pending payments and customer ledgers' },
  'ledger.adjust': { module: 'Billing', label: 'Post adjustments and discounts after billing' },
  'ledger.write_off': { module: 'Billing', label: 'Write off pending amounts' },

  'reports.operations': { module: 'Reports', label: 'Appointment and customer reports' },
  'reports.financial': { module: 'Reports', label: 'Revenue, collection and outstanding reports' },
  'reports.staff': { module: 'Reports', label: 'Staff and attendance reports' },

  'notifications.view': { module: 'Notifications', label: 'See message logs' },
  'notifications.manage': { module: 'Notifications', label: 'Edit message templates' },
  'campaigns.manage': { module: 'Notifications', label: 'Send campaigns' },

  'branches.manage': { module: 'Administration', label: 'Manage branches, hours and holidays' },
  'users.manage': { module: 'Administration', label: 'Manage user accounts' },
  'roles.manage': { module: 'Administration', label: 'Manage roles and permissions' },
  'settings.manage': { module: 'Administration', label: 'Manage salon settings' },
  'integrations.manage': { module: 'Administration', label: 'Manage WhatsApp, email, SMS and device connections' },
  'audit.view': { module: 'Administration', label: 'See activity log' },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  homeScreen: HomeScreen;
  /** Owner is locked: always every permission, cannot be edited or deleted. */
  locked: boolean;
  /** Default branch scope for new users with this role. */
  allBranches: boolean;
  permissions: Permission[];
}

const RECEPTIONIST: Permission[] = [
  'dashboard.branch',
  'appointments.view',
  'appointments.create',
  'appointments.update',
  'appointments.status',
  'appointments.cancel',
  'walkins.manage',
  'customers.view',
  'customers.view_contact',
  'customers.create',
  'customers.update',
  'services.view',
  'staff.view',
  'attendance.view',
  'billing.view',
  'billing.create',
  'payments.collect',
  'ledger.view',
  'notifications.view',
];

const BRANCH_MANAGER: Permission[] = [
  ...RECEPTIONIST,
  'appointments.override_hours',
  'customers.archive',
  'customers.export',
  'staff.manage',
  'staff.schedule',
  'staff.performance',
  'attendance.manage',
  'billing.discount',
  'billing.void',
  'billing.override_credit_limit',
  'payments.void',
  'payments.refund',
  'ledger.adjust',
  'reports.operations',
  'reports.financial',
  'reports.staff',
  'audit.view',
];

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access to every branch and setting.',
    homeScreen: 'owner_dashboard',
    locked: true,
    allBranches: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    description: 'Runs a branch: staff, schedules, billing corrections and reports.',
    homeScreen: 'branch_dashboard',
    locked: false,
    allBranches: false,
    permissions: BRANCH_MANAGER,
  },
  {
    key: 'receptionist',
    name: 'Receptionist',
    description: 'Front desk: bookings, walk-ins, customers, bills and payments.',
    homeScreen: 'front_desk',
    locked: false,
    allBranches: false,
    permissions: RECEPTIONIST,
  },
  {
    key: 'staff',
    name: 'Staff',
    description: 'Stylists and therapists: their own schedule and service status.',
    homeScreen: 'my_day',
    locked: false,
    allBranches: false,
    permissions: ['appointments.view_own', 'appointments.status', 'services.view'],
  },
];

/** Powers that make someone a "manager" for security policies: money corrections, user and salon administration, exports. */
export const MANAGER_PERMISSIONS: readonly Permission[] = [
  'billing.void',
  'payments.void',
  'payments.refund',
  'ledger.adjust',
  'billing.override_credit_limit',
  'customers.export',
  'audit.view',
  'reports.financial',
  'staff.manage',
  'attendance.manage',
  'branches.manage',
  'users.manage',
  'roles.manage',
  'settings.manage',
  'integrations.manage',
];

/** Does the salon's two-step policy apply to a user with this role and these permissions? */
export function twoFactorApplies(requirement: TwoFactorRequirement, roleKey: string | null, permissions: ReadonlySet<Permission> | readonly Permission[]): boolean {
  if (requirement === 'off') return false;
  if (roleKey === 'owner') return true;
  if (requirement !== 'owners_and_managers') return false;
  const has = (p: Permission) => (Array.isArray(permissions) ? (permissions as readonly Permission[]).includes(p) : (permissions as ReadonlySet<Permission>).has(p));
  return MANAGER_PERMISSIONS.some(has);
}
