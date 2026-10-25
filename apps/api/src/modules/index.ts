import { Router } from 'express';
import type { ModuleRouter } from '../core/router.js';
import { analyticsRoutes } from './analytics/routes.js';
import { appointmentRoutes, walkInRoutes } from './appointments/routes.js';
import { attendanceRoutes, biometricWebhookRoutes } from './attendance/routes.js';
import { authRoutes } from './auth/routes.js';
import { billingRoutes, ledgerRoutes, outstandingRoutes, paymentRoutes } from './billing/routes.js';
import { branchRoutes, holidayRoutes } from './branches/routes.js';
import { categoryRoutes, expertiseRoutes, serviceRoutes } from './catalog/routes.js';
import { customerRoutes, segmentRoutes } from './customers/routes.js';
import { customerPackageRoutes, offerRoutes, packageRoutes } from './offers/routes.js';
import { dashboardRoutes } from './dashboards/routes.js';
import { integrationRoutes } from './integrations/routes.js';
import { campaignRoutes, notificationRoutes, templateRoutes, webhookRoutes } from './notifications/routes.js';
import { organizationRoutes, platformRoutes } from './organizations/routes.js';
import { publicBookingRoutes } from './public-booking/routes.js';
import { reportRoutes } from './reports/routes.js';
import { auditRoutes, searchRoutes } from './search/routes.js';
import { schedulingRoutes } from './scheduling/routes.js';
import { leaveRoutes, staffRoutes, timeBlockRoutes } from './staff/routes.js';
import { roleRoutes, userRoutes } from './users/routes.js';

const modules: ModuleRouter[] = [
  authRoutes,
  platformRoutes,
  organizationRoutes,
  branchRoutes,
  holidayRoutes,
  userRoutes,
  roleRoutes,
  expertiseRoutes,
  categoryRoutes,
  serviceRoutes,
  staffRoutes,
  leaveRoutes,
  timeBlockRoutes,
  customerRoutes,
  segmentRoutes,
  schedulingRoutes,
  appointmentRoutes,
  walkInRoutes,
  billingRoutes,
  paymentRoutes,
  ledgerRoutes,
  outstandingRoutes,
  offerRoutes,
  packageRoutes,
  customerPackageRoutes,
  templateRoutes,
  notificationRoutes,
  campaignRoutes,
  webhookRoutes,
  biometricWebhookRoutes,
  attendanceRoutes,
  integrationRoutes,
  dashboardRoutes,
  analyticsRoutes,
  reportRoutes,
  searchRoutes,
  auditRoutes,
  publicBookingRoutes,
];

export const apiRouter = Router();
for (const module of modules) {
  apiRouter.use(module.basePath, module.router);
}
