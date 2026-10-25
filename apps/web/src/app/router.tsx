import type { Permission } from '@salon/shared';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { Forbidden, HomeRedirect, NotFound, RequireAuth, RequirePermission, RequirePlatformAdmin } from './guards';
import { RouteError } from './RouteError';

// Every screen is its own chunk, loaded when first visited, so the front desk opens fast on a modest phone.
// `lazy` modules export a `Component`. `handle.crumb` feeds the breadcrumb in the top bar.

const page = (load: () => Promise<{ Component: React.ComponentType }>, crumb?: string): RouteObject => ({ lazy: load, handle: crumb ? { crumb } : undefined });
const guarded = (any: Permission[], children: RouteObject[], crumb?: string, path?: string): RouteObject => ({ path, handle: crumb ? { crumb } : undefined, element: <RequirePermission any={any} />, children });

const routes: RouteObject[] = [
  { path: '/login', lazy: () => import('@/features/auth/LoginPage'), errorElement: <RouteError /> },
  // Public online booking (no sign-in)
  { path: '/book/manage/:token', lazy: () => import('@/features/public/ManageBookingPage'), errorElement: <RouteError /> },
  { path: '/book/:code', lazy: () => import('@/features/public/PublicBookingPage'), errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomeRedirect /> },
          { path: 'change-password', ...page(() => import('@/features/auth/ChangePasswordPage'), 'Change password') },
          { path: 'security', ...page(() => import('@/features/auth/SecurityPage'), 'Account security') },
          { path: 'forbidden', element: <Forbidden /> },

          // Dashboards and the front desk
          guarded(['dashboard.business'], [{ path: 'dashboard', ...page(() => import('@/features/dashboards/OwnerDashboardPage'), 'Dashboard') }]),
          guarded(['dashboard.branch'], [{ path: 'today', ...page(() => import('@/features/dashboards/TodayPage'), 'Today at the salon') }]),
          guarded(['appointments.view_own'], [{ path: 'my-day', ...page(() => import('@/features/dashboards/MyDayPage'), 'My day') }]),
          guarded(['appointments.create', 'walkins.manage', 'billing.create'], [{ path: 'desk', ...page(() => import('@/features/desk/FrontDeskPage'), 'Front desk') }]),

          // Appointments
          guarded(['appointments.view'], [
            { path: 'appointments/calendar', ...page(() => import('@/features/appointments/CalendarPage'), 'Calendar') },
            { path: 'appointments', ...page(() => import('@/features/appointments/AppointmentListPage'), 'Appointments') },
            { path: 'appointments/:id', ...page(() => import('@/features/appointments/AppointmentListPage'), 'Appointments') },
          ]),
          guarded(['walkins.manage', 'appointments.view'], [{ path: 'walk-ins', ...page(() => import('@/features/walkins/WalkInsPage'), 'Walk-ins') }]),

          // Customers
          guarded(['customers.view'], [
            { path: 'customers', ...page(() => import('@/features/customers/CustomersPage'), 'Customers') },
            { path: 'customers/segments', ...page(() => import('@/features/customers/SegmentsPage'), 'Customer groups') },
            { path: 'customers/:id', ...page(() => import('@/features/customers/Customer360Page'), 'Customer') },
          ]),

          // Services
          guarded(['services.view'], [{ path: 'services', ...page(() => import('@/features/services/ServicesPage'), 'Services') }]),
          guarded(['services.manage'], [
            { path: 'services/categories', ...page(() => import('@/features/services/CategoriesPage'), 'Categories') },
            { path: 'services/expertise', ...page(() => import('@/features/services/ExpertisePage'), 'Expertise') },
          ]),
          guarded(['packages.manage'], [{ path: 'services/packages', ...page(() => import('@/features/services/PackagesPage'), 'Packages and combos') }]),
          guarded(['offers.manage'], [{ path: 'services/offers', ...page(() => import('@/features/services/OffersPage'), 'Offers') }]),

          // Team
          guarded(['staff.view'], [
            { path: 'staff', ...page(() => import('@/features/staff/StaffListPage'), 'Team') },
            { path: 'staff/schedule', ...page(() => import('@/features/staff/StaffSchedulePage'), 'Schedules and leave') },
            { path: 'staff/:id', ...page(() => import('@/features/staff/StaffProfilePage'), 'Team member') },
          ]),
          guarded(['staff.manage'], [{ path: 'staff/mapping', ...page(() => import('@/features/staff/StaffMappingPage'), 'Assign services') }]),
          guarded(['attendance.view', 'attendance.manage'], [{ path: 'staff/attendance', ...page(() => import('@/features/staff/AttendancePage'), 'Attendance') }]),

          // Billing
          guarded(['billing.create'], [{ path: 'billing/new', ...page(() => import('@/features/billing/NewBillPage'), 'New bill') }]),
          guarded(['billing.view'], [
            { path: 'billing/bills', ...page(() => import('@/features/billing/BillsPage'), 'Bills') },
            { path: 'billing/bills/:id', ...page(() => import('@/features/billing/BillDetailPage'), 'Bill') },
          ]),
          guarded(['payments.collect'], [{ path: 'billing/collect', ...page(() => import('@/features/billing/CollectPaymentPage'), 'Collect payment') }]),
          guarded(['ledger.view', 'reports.financial'], [{ path: 'billing/pending', ...page(() => import('@/features/billing/PendingPaymentsPage'), 'Pending payments') }]),
          guarded(['billing.view', 'payments.collect'], [
            { path: 'billing/payments', lazy: async () => ({ Component: (await import('@/features/billing/BillsPage')).PaymentsComponent }), handle: { crumb: 'Payments received' } },
            { path: 'billing/payments/:id', ...page(() => import('@/features/billing/PaymentDetailPage'), 'Payment') },
          ]),
          guarded(['ledger.view'], [{ path: 'billing/ledger', ...page(() => import('@/features/billing/LedgerPage'), 'Customer ledger') }]),

          // Reports
          guarded(['reports.operations', 'reports.financial', 'reports.staff', 'attendance.view', 'ledger.view'], [
            { path: 'reports', ...page(() => import('@/features/reports/ReportsPage'), 'Reports') },
            { path: 'reports/:key', ...page(() => import('@/features/reports/ReportViewerPage'), 'Report') },
          ]),

          // Messages
          guarded(['notifications.view', 'notifications.manage'], [
            { path: 'notifications/templates', ...page(() => import('@/features/notifications/TemplatesPage'), 'Message templates') },
            { path: 'notifications/logs', ...page(() => import('@/features/notifications/DeliveryLogPage'), 'Delivery') },
          ]),
          guarded(['campaigns.manage', 'notifications.view'], [{ path: 'notifications/campaigns', ...page(() => import('@/features/notifications/CampaignsPage'), 'Campaigns') }]),

          // Salon administration
          guarded(['branches.manage'], [{ path: 'branches', ...page(() => import('@/features/admin/BranchesPage'), 'Branches') }]),
          guarded(['users.manage', 'roles.manage'], [{ path: 'users', ...page(() => import('@/features/admin/UsersPage'), 'Users and roles') }]),
          guarded(['audit.view'], [{ path: 'activity', ...page(() => import('@/features/admin/ActivityLogPage'), 'Activity log') }]),
          guarded(['settings.manage', 'integrations.manage'], [{ path: 'settings', ...page(() => import('@/features/admin/SettingsPage'), 'Settings') }]),
          guarded(['settings.manage'], [{ path: 'settings/setup', ...page(() => import('@/features/admin/SetupGuidePage'), 'Setup guide') }]),

          // Platform operator
          { element: <RequirePlatformAdmin />, children: [{ path: 'platform', ...page(() => import('@/features/admin/PlatformPage'), 'Platform') }] },

          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
];

export const router = createBrowserRouter(routes);
