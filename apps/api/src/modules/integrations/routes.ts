import { integrationSchema, type IntegrationKind } from '@salon/shared';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, requireOrgId } from '../../core/auth-context.js';
import { decryptSecret, encryptSecret, randomToken } from '../../core/crypto.js';
import { AppError, notFound } from '../../core/errors.js';
import { assertPublicUrl } from '../../core/net.js';
import { createRouter } from '../../core/router.js';
import { withSystem, type Tx } from '../../db/tenant.js';
import { BIOMETRIC_PROVIDERS } from '../../integrations/biometric/providers.js';
import { PAYMENT_GATEWAYS } from '../../integrations/payments/gateway.js';
import { ConsoleProvider, organizationProvider, ProviderError, type ProviderConfig } from '../../integrations/notifications/providers.js';
import { clearProviderCache } from '../notifications/dispatcher.js';
import { availableChannels } from '../notifications/outbox.js';
import { syncIntegration } from '../attendance/service.js';

const r = createRouter('/integrations', 'Integrations');

type Input = z.output<typeof integrationSchema>;

const PROVIDERS: Record<IntegrationKind, readonly string[]> = {
  whatsapp: ['meta_cloud'],
  email: ['smtp'],
  sms: ['http'],
  biometric: BIOMETRIC_PROVIDERS,
  payment_gateway: PAYMENT_GATEWAYS,
};

const REQUIRED: Record<string, { config: string[]; secrets: string[] }> = {
  'whatsapp:meta_cloud': { config: ['phoneNumberId'], secrets: ['accessToken'] },
  'email:smtp': { config: ['host', 'from'], secrets: [] },
  'sms:http': { config: ['apiUrl'], secrets: ['apiKey'] },
  'biometric:generic_http': { config: ['apiUrl'], secrets: [] },
  'biometric:push_webhook': { config: [], secrets: [] },
};

function issue(path: string, message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message, { issues: [{ path, message }] });
}

async function validate(input: Input, existingSecretKeys: string[] = []): Promise<void> {
  if (!PROVIDERS[input.kind].includes(input.provider)) throw issue('provider', 'This provider is not supported.');
  const need = REQUIRED[`${input.kind}:${input.provider}`];
  for (const key of need?.config ?? []) if (!input.config[key]) throw issue(`config.${key}`, `${key} is required.`);
  for (const key of need?.secrets ?? []) if (!input.secrets?.[key] && !existingSecretKeys.includes(key)) throw issue(`secrets.${key}`, `${key} is required.`);
  if (typeof input.config.apiUrl === 'string') await assertPublicUrl(input.config.apiUrl, 'config.apiUrl');
}

const dto = (row: { id: string; kind: string; provider: string; displayName: string; branchId: string | null; config: unknown; secretsEncrypted: string | null; webhookSecret: string | null; status: string; lastSyncAt: Date | null; lastSuccessAt: Date | null; lastError: string | null; lastErrorAt: Date | null; createdAt: Date }) => ({
  id: row.id,
  kind: row.kind,
  provider: row.provider,
  displayName: row.displayName,
  branchId: row.branchId,
  config: row.config as Record<string, unknown>,
  // Secrets are write-only: only the names of the ones that are set are returned.
  secretKeys: row.secretsEncrypted ? Object.keys(JSON.parse(decryptSecret(row.secretsEncrypted)) as Record<string, string>) : [],
  hasWebhookSecret: !!row.webhookSecret,
  webhookUrl: row.provider === 'push_webhook' ? `${env.API_BASE_URL}/api/v1/webhooks/biometric/${row.id}` : null,
  status: row.status,
  lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
  lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
  lastError: row.lastError,
  lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

async function load(tx: Tx, orgId: string, id: string) {
  const row = await tx.selectFrom('organizationIntegrations').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Connection');
  return row;
}

r.get('/', { summary: 'Connections: WhatsApp, email, SMS, attendance devices (secrets are never returned)', permissions: ['integrations.manage'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await t.selectFrom('organizationIntegrations').selectAll().where('organizationId', '=', orgId).where('status', '!=', 'inactive').orderBy('kind').orderBy('displayName').execute();
    return { items: rows.map(dto), platformChannels: [...(await availableChannels(t, orgId))], providers: PROVIDERS };
  }),
);

r.post('/', { summary: 'Add a connection', permissions: ['integrations.manage'], body: integrationSchema }, async ({ tx, auth, body }) => {
  if (body.branchId) assertBranchAccess(auth, body.branchId);
  await validate(body);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const webhookSecret = body.provider === 'push_webhook' ? randomToken(32) : null;
    const row = await t
      .insertInto('organizationIntegrations')
      .values({ organizationId: orgId, branchId: body.branchId, kind: body.kind, provider: body.provider, displayName: body.displayName, config: JSON.stringify(body.config), secretsEncrypted: body.secrets && Object.keys(body.secrets).length ? encryptSecret(JSON.stringify(body.secrets)) : null, webhookSecret, status: body.status, createdBy: auth.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    clearProviderCache();
    await audit(t, auth, { action: 'integration.created', entityType: 'integration', entityId: row.id, branchId: body.branchId, summary: `${body.kind} connection "${body.displayName}" added`, after: { kind: body.kind, provider: body.provider, config: body.config } });
    // The webhook secret is shown once, at creation, so it can be entered on the device.
    return { ...dto(row), webhookSecretOnce: webhookSecret };
  });
});

r.put('/:id', { summary: 'Edit a connection (leave a secret empty to keep the saved one)', permissions: ['integrations.manage'], body: integrationSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await load(t, orgId, params.id!);
    const existing = before.secretsEncrypted ? (JSON.parse(decryptSecret(before.secretsEncrypted)) as Record<string, string>) : {};
    await validate(body, Object.keys(existing));
    const merged = { ...existing, ...Object.fromEntries(Object.entries(body.secrets ?? {}).filter(([, v]) => v)) };
    const row = await t
      .updateTable('organizationIntegrations')
      .set({ displayName: body.displayName, branchId: body.branchId, config: JSON.stringify(body.config), secretsEncrypted: Object.keys(merged).length ? encryptSecret(JSON.stringify(merged)) : null, status: body.status, updatedAt: new Date(), ...(body.status === 'active' ? { lastError: null } : {}) })
      .where('id', '=', before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    clearProviderCache();
    await audit(t, auth, { action: 'integration.updated', entityType: 'integration', entityId: row.id, summary: `${row.kind} connection "${row.displayName}" updated`, before: { config: before.config, status: before.status }, after: { config: body.config, status: body.status, secretsChanged: Object.keys(body.secrets ?? {}).filter((k) => body.secrets?.[k]) } });
    return dto(row);
  }),
);

r.delete('/:id', { summary: 'Disconnect', permissions: ['integrations.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t.updateTable('organizationIntegrations').set({ status: 'inactive' }).where('organizationId', '=', requireOrgId(auth)).where('id', '=', params.id!).returning(['id', 'displayName', 'kind']).executeTakeFirst();
    if (!row) throw notFound('Connection');
    clearProviderCache();
    await audit(t, auth, { action: 'integration.disconnected', entityType: 'integration', entityId: row.id, summary: `${row.kind} connection "${row.displayName}" disconnected` });
    return undefined;
  }),
);

r.post('/:id/rotate-secret', { summary: 'Generate a new device webhook secret (shown once)', permissions: ['integrations.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await load(t, requireOrgId(auth), params.id!);
    if (row.provider !== 'push_webhook') throw new AppError(409, 'CONFLICT', 'Only push connections have a webhook secret.');
    const secret = randomToken(32);
    await t.updateTable('organizationIntegrations').set({ webhookSecret: secret }).where('id', '=', row.id).execute();
    await audit(t, auth, { action: 'integration.secret_rotated', entityType: 'integration', entityId: row.id, summary: `Webhook secret rotated for "${row.displayName}"` });
    return { webhookSecret: secret };
  }),
);

r.post('/:id/test', { summary: 'Send a test message or check the device connection', permissions: ['integrations.manage'], body: z.object({ to: z.string().trim().min(5).max(120).optional() }), status: 200 }, async ({ tx, auth, params, body }) => {
  const orgId = requireOrgId(auth);
  const row = await tx((t) => load(t, orgId, params.id!));
  const secrets = row.secretsEncrypted ? (JSON.parse(decryptSecret(row.secretsEncrypted)) as Record<string, string>) : {};
  const config = (row.config ?? {}) as ProviderConfig;

  if (row.kind === 'biometric') {
    if (row.provider === 'push_webhook') return { ok: true, detail: row.lastSuccessAt ? `Last punches received ${row.lastSuccessAt.toISOString()}` : 'Waiting for the first punches from the device.' };
    const outcome = await syncIntegration(row.id);
    return { ok: outcome.ok, detail: outcome.ok ? `Connected. ${outcome.inserted} new punches.` : outcome.error };
  }
  if (!['whatsapp', 'email', 'sms'].includes(row.kind)) return { ok: true, detail: 'Nothing to test for this connection.' };
  if (!body.to) throw issue('to', 'Enter a phone number or email to send the test to.');
  const channel = row.kind as 'whatsapp' | 'email' | 'sms';
  const provider = env.NOTIFICATIONS_MODE === 'console' ? new ConsoleProvider(channel) : organizationProvider(channel, row.provider, config, secrets);
  if (!provider) throw issue('provider', 'This connection is missing some details.');
  try {
    await provider.send({ notificationId: 'test', organizationId: orgId, channel, to: body.to, subject: 'Test message', body: 'This is a test message from your salon software. If you can read this, messaging is working.', providerTemplateName: null, orderedVariables: [] });
    await withSystem((t) => t.updateTable('organizationIntegrations').set({ lastSuccessAt: new Date(), lastError: null, lastErrorAt: null, status: 'active' }).where('id', '=', row.id).execute());
    return { ok: true, detail: 'Test message sent.' };
  } catch (error) {
    const detail = error instanceof ProviderError ? error.message : (error as Error).message;
    await withSystem((t) => t.updateTable('organizationIntegrations').set({ lastError: detail.slice(0, 500), lastErrorAt: new Date() }).where('id', '=', row.id).execute());
    return { ok: false, detail };
  }
});

export const integrationRoutes = r;
