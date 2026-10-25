import { attendanceOverrideSchema, attendanceQuery, biometricPushSchema, manualPunchSchema } from '@salon/shared';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, branchFilter, requireOrgId } from '../../core/auth-context.js';
import { decryptSecret, hmacSha256, safeEqual } from '../../core/crypto.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { localDateOf, todayIn } from '../../core/time.js';
import { loadBranch } from '../../core/validation.js';
import { withSystem } from '../../db/tenant.js';
import { ingestPunches, isTracked, loadAttendanceDays, recomputeBranch, remapUnmappedPunches, syncIntegration } from './service.js';

const r = createRouter('/attendance', 'Attendance');
const VIEW = ['attendance.view', 'attendance.manage'] as const;

r.get('/day', { summary: 'Attendance for one day: present, late, absent, on leave, missing punch', permissions: [...VIEW], query: z.object({ branchId: z.uuid(), date: z.iso.date().optional() }) }, async ({ tx, auth, query }) => {
  assertBranchAccess(auth, query.branchId);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const branch = await loadBranch(t, orgId, query.branchId);
    const date = query.date ?? todayIn(branch.timezone);
    await recomputeBranch(t, orgId, branch, date, date);
    const rows = await loadAttendanceDays(t, orgId, [branch.id], { from: date, to: date });
    const count = (...s: string[]) => rows.filter((x) => s.includes(x.status)).length;
    const integrations = await t
      .selectFrom('organizationIntegrations')
      .select(['id', 'displayName', 'provider', 'status', 'lastSyncAt', 'lastSuccessAt', 'lastError'])
      .where('organizationId', '=', orgId)
      .where('kind', '=', 'biometric')
      .where('status', '!=', 'inactive')
      .where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branch.id)]))
      .execute();
    const unmapped = await t
      .selectFrom('attendancePunches')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organizationId', '=', orgId)
      .where('staffId', 'is', null)
      .where('punchedAt', '>', new Date(Date.now() - 7 * 86400_000))
      .executeTakeFirstOrThrow();
    return {
      date,
      tracked: await isTracked(t, orgId, branch.id),
      summary: {
        present: count('present', 'late', 'half_day'),
        late: count('late'),
        absent: count('absent'),
        onLeave: count('on_leave'),
        missingPunch: count('missing_punch'),
        notStarted: count('not_started'),
        off: count('weekly_off', 'holiday'),
      },
      rows,
      integrations: integrations.map((i) => ({ ...i, lastSyncAt: i.lastSyncAt?.toISOString() ?? null, lastSuccessAt: i.lastSuccessAt?.toISOString() ?? null })),
      unmappedPunches: unmapped.n,
    };
  });
});

r.get('/', { summary: 'Attendance history (filter by date range, branch, staff)', permissions: [...VIEW], query: attendanceQuery.extend({ from: z.iso.date(), to: z.iso.date() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const branches = branchFilter(auth, query.branchId);
    for (const id of branches) {
      const branch = await loadBranch(t, orgId, id);
      await recomputeBranch(t, orgId, branch, query.from, query.to);
    }
    return loadAttendanceDays(t, orgId, branches, { from: query.from!, to: query.to!, staffId: query.staffId });
  }),
);

r.post('/punches', { summary: 'Add a missing punch by hand (reason required, audited)', permissions: ['attendance.manage'], body: manualPunchSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await t.selectFrom('staff').select(['id', 'branchId', 'displayName', 'biometricPunchId']).where('organizationId', '=', orgId).where('id', '=', body.staffId).executeTakeFirst();
    if (!staff) throw notFound('Team member');
    assertBranchAccess(auth, staff.branchId);
    const punch = await t
      .insertInto('attendancePunches')
      .values({ organizationId: orgId, branchId: staff.branchId, staffId: staff.id, punchId: staff.biometricPunchId ?? 'manual', punchedAt: new Date(body.punchedAt), direction: body.direction, source: 'manual', externalId: crypto.randomUUID(), raw: JSON.stringify({ reason: body.reason }), createdBy: auth.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const branch = await loadBranch(t, orgId, staff.branchId);
    const date = localDateOf(new Date(body.punchedAt), branch.timezone);
    await recomputeBranch(t, orgId, branch, date, date);
    await audit(t, auth, { action: 'attendance.punch_added', entityType: 'attendance_punch', entityId: punch.id, branchId: staff.branchId, summary: `Manual ${body.direction} punch for ${staff.displayName}: ${body.reason}`, after: { punchedAt: body.punchedAt, direction: body.direction } });
    return { id: punch.id };
  }),
);

r.post('/override', { summary: 'Correct a day’s attendance status (reason required, audited)', permissions: ['attendance.manage'], body: attendanceOverrideSchema, status: 200 }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await t.selectFrom('staff').select(['id', 'branchId', 'displayName']).where('organizationId', '=', orgId).where('id', '=', body.staffId).executeTakeFirst();
    if (!staff) throw notFound('Team member');
    assertBranchAccess(auth, staff.branchId);
    const before = await t.selectFrom('attendanceDays').select(['status']).where('staffId', '=', staff.id).where('date', '=', body.date).executeTakeFirst();
    await t
      .insertInto('attendanceDays')
      .values({ organizationId: orgId, branchId: staff.branchId, staffId: staff.id, date: body.date, status: body.status, isManualOverride: true, overrideReason: body.reason, overriddenBy: auth.userId })
      .onConflict((oc) => oc.columns(['staffId', 'date']).doUpdateSet({ status: body.status, isManualOverride: true, overrideReason: body.reason, overriddenBy: auth.userId, computedAt: new Date() }))
      .execute();
    await audit(t, auth, { action: 'attendance.overridden', entityType: 'attendance_day', entityId: `${staff.id}:${body.date}`, branchId: staff.branchId, summary: `Attendance for ${staff.displayName} on ${body.date} set to ${body.status}: ${body.reason}`, before: { status: before?.status ?? null }, after: { status: body.status } });
    return { staffId: staff.id, date: body.date, status: body.status };
  }),
);

r.get('/punches/unmapped', { summary: 'Device punches that do not match any staff member yet', permissions: ['attendance.manage'] }, async ({ tx, auth }) =>
  tx((t) =>
    t
      .selectFrom('attendancePunches')
      .select(['punchId', (eb) => eb.fn.countAll<number>().as('punches'), (eb) => eb.fn.min('punchedAt').as('firstAt'), (eb) => eb.fn.max('punchedAt').as('lastAt')])
      .where('organizationId', '=', requireOrgId(auth))
      .where('staffId', 'is', null)
      .groupBy('punchId')
      .orderBy('punchId')
      .limit(200)
      .execute()
      .then((rows) => rows.map((x) => ({ punchId: x.punchId, punches: Number(x.punches), firstAt: x.firstAt?.toISOString() ?? null, lastAt: x.lastAt?.toISOString() ?? null }))),
  ),
);

r.post('/sync', { summary: 'Pull the latest punches now (a device outage never breaks anything else)', permissions: ['attendance.manage'], status: 200 }, async ({ tx, auth }) => {
  const orgId = requireOrgId(auth);
  const integrations = await tx((t) => t.selectFrom('organizationIntegrations').select('id').where('organizationId', '=', orgId).where('kind', '=', 'biometric').where('status', '!=', 'inactive').execute());
  const results = [];
  for (const i of integrations) results.push(await syncIntegration(i.id));
  await tx(async (t) => {
    await remapUnmappedPunches(t, orgId);
    const branches = await t.selectFrom('branches').selectAll().where('organizationId', '=', orgId).where('id', 'in', auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000']).execute();
    for (const b of branches) await recomputeBranch(t, orgId, b, todayIn(b.timezone), todayIn(b.timezone));
  });
  return { results, anyFailed: results.some((x) => !x.ok) };
});

// ───────────── Push webhook (devices / vendor clouds call us) ─────────────
const hooks = createRouter('/webhooks', 'Webhooks');

hooks.post('/biometric/:integrationId', { summary: 'Receive punches pushed by an attendance device (HMAC-signed)', auth: 'public', body: biometricPushSchema, status: 200 }, async ({ req, params, body }) => {
  const integration = await withSystem((tx) =>
    tx.selectFrom('organizationIntegrations').select(['id', 'organizationId', 'branchId', 'webhookSecret', 'secretsEncrypted', 'status']).where('id', '=', params.integrationId!).where('kind', '=', 'biometric').executeTakeFirst(),
  );
  const secret = integration?.webhookSecret ? integration.webhookSecret : integration?.secretsEncrypted ? (JSON.parse(decryptSecret(integration.secretsEncrypted)) as Record<string, string>).webhookSecret : undefined;
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const signature = (req.get('x-signature') ?? '').replace(/^sha256=/, '');
  if (!integration || integration.status === 'inactive' || !secret || !raw || !safeEqual(signature, hmacSha256(secret, raw.toString('utf8')))) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid signature.');
  }
  const result = await withSystem(async (tx) => {
    const res = await ingestPunches(tx, integration.organizationId, { id: integration.id, branchId: integration.branchId }, body.punches.map((p) => ({ externalId: p.externalId, punchId: p.punchId, punchedAt: new Date(p.punchedAt), direction: p.direction })), 'biometric_push');
    await tx.updateTable('organizationIntegrations').set({ lastSyncAt: new Date(), lastSuccessAt: new Date(), lastError: null, status: 'active' }).where('id', '=', integration.id).execute();
    return res;
  });
  return result;
});

export const attendanceRoutes = r;
export const biometricWebhookRoutes = hooks;
