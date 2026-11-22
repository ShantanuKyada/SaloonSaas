import type { Permission } from './permissions.js';

// Parts of SalonOS the platform can switch on or off for each salon. A switched-off feature disappears for everyone
// in that salon: the permissions listed here are taken away from every role (so its screens and API close), and the
// few places that use a feature without a permission of its own check it directly.

interface FeatureDef {
  label: string;
  description: string;
  /** Permissions that only make sense with this feature: removed from every role while it is off. */
  permissions: readonly Permission[];
}

export const FEATURES = {
  online_booking: { label: 'Online booking', description: 'Customers book from the salon’s own booking page.', permissions: [] },
  recurring: { label: 'Repeating appointments', description: 'Bookings that repeat every few weeks, made at the front desk or by customers from their private link.', permissions: [] },
  customer_portal: { label: 'Customer self-service', description: 'From their private link, customers see their upcoming and past visits and book again.', permissions: [] },
  walk_ins: { label: 'Walk-in queue', description: 'The walk-in board and adding walk-ins at the desk.', permissions: ['walkins.manage'] },
  packages: { label: 'Packages and combos', description: 'Selling packages and combos, and managing them.', permissions: ['packages.manage'] },
  offers: { label: 'Offers', description: 'Discount offers applied on bills, and managing them.', permissions: ['offers.manage'] },
  campaigns: { label: 'Campaigns', description: 'Sending offers and news to customer groups.', permissions: ['campaigns.manage'] },
  attendance: { label: 'Attendance', description: 'Punches from attendance machines, corrections and attendance reports.', permissions: ['attendance.view', 'attendance.manage'] },
  reports: { label: 'Reports', description: 'The reports section and its downloads.', permissions: ['reports.operations', 'reports.financial', 'reports.staff'] },
  staff_app: { label: 'Staff app', description: 'My day, my appointments, schedule and leave requests, and booking alerts for team members.', permissions: ['appointments.view_own'] },
} as const satisfies Record<string, FeatureDef>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, value);
}

/** Permissions taken away by the switched-off features. */
export function permissionsOffFor(disabled: readonly string[]): Set<Permission> {
  const off = new Set<Permission>();
  for (const key of disabled) if (isFeatureKey(key)) for (const p of FEATURES[key].permissions) off.add(p);
  return off;
}
