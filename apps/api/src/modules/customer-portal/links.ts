import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import type { Tx } from '../../db/tenant.js';

// A customer's private link: an unguessable address that opens one booking and, while the salon has customer
// self-service on, that customer's other visits. Only a hash of the link is stored, so a link can be shown once (in the
// message or on screen) and never read back; a new one is made each time one is needed.

export const manageUrl = (token: string): string => `${env.APP_BASE_URL}/book/manage/${token}`;

/** Makes a new private link to a booking for its customer and returns the full address. */
export async function createCustomerLink(tx: Tx, orgId: string, appointmentId: string, customerId: string): Promise<string> {
  const token = randomToken(32);
  await tx.insertInto('customerLinks').values({ organizationId: orgId, customerId, appointmentId, tokenHash: sha256(token) }).execute();
  return manageUrl(token);
}

export interface LinkHolder {
  orgId: string;
  appointmentId: string;
  customerId: string;
}

const NOT_FOUND = 'We could not find this booking. The link may be incorrect.';

/** Who and which booking a private link belongs to. Runs outside any salon (the link itself says which one). */
export async function resolveLink(tx: Tx, token: string): Promise<LinkHolder> {
  if (!token || token.length > 200) throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
  const hash = sha256(token);
  const link = await tx
    .selectFrom('customerLinks as l')
    .innerJoin('customers as c', (j) => j.onRef('c.id', '=', 'l.customerId').onRef('c.organizationId', '=', 'l.organizationId'))
    .select(['l.id', 'l.organizationId', 'l.appointmentId', 'l.customerId', 'l.expiresAt', 'c.status as customerStatus'])
    .where('l.tokenHash', '=', hash)
    .executeTakeFirst();
  if (link) {
    if (link.customerStatus === 'archived') throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
    if (link.expiresAt.getTime() < Date.now()) throw new AppError(404, 'NOT_FOUND', 'This link has expired. Please use the link in your latest message from the salon, or call them.');
    await tx.updateTable('customerLinks').set({ lastUsedAt: new Date() }).where('id', '=', link.id).execute();
    return { orgId: link.organizationId, appointmentId: link.appointmentId, customerId: link.customerId };
  }
  // Links sent before customer_links existed were kept on the booking itself.
  const legacy = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as c', (j) => j.onRef('c.id', '=', 'a.customerId').onRef('c.organizationId', '=', 'a.organizationId'))
    .select(['a.id', 'a.organizationId', 'a.customerId', 'c.status as customerStatus'])
    .where('a.manageTokenHash', '=', hash)
    .executeTakeFirst();
  if (!legacy || legacy.customerStatus === 'archived') throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
  return { orgId: legacy.organizationId, appointmentId: legacy.id, customerId: legacy.customerId };
}
