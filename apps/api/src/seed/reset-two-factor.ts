import { audit } from '../core/audit.js';
import { systemContext } from '../core/auth-context.js';
import { closeDb } from '../db/pool.js';
import { withSystem } from '../db/tenant.js';
import { clearTwoFactor } from '../modules/auth/mfa.js';
import { revokeAllSessions } from '../modules/auth/service.js';

// Last-resort recovery for someone who lost their phone and their recovery codes when no other owner can reset it for them:
//   USER_EMAIL=owner@salon.example npm run user:reset-2fa -w @salon/api
// It switches off their two-step sign-in, signs them out everywhere and writes an audit entry. If the salon requires
// two-step sign-in they set it up again at their next sign-in.

const email = process.env.USER_EMAIL?.trim().toLowerCase();
if (!email) {
  console.error('Set USER_EMAIL to the account whose two-step sign-in should be switched off.');
  process.exit(1);
}

await withSystem(async (tx) => {
  const user = await tx.selectFrom('users').select(['id', 'organizationId', 'fullName', 'totpEnabledAt']).where('email', '=', email).executeTakeFirst();
  if (!user) {
    console.error(`No user with the email ${email}.`);
    process.exitCode = 1;
    return;
  }
  if (!user.totpEnabledAt) {
    console.log(`${email} does not have two-step sign-in switched on; nothing to do.`);
    return;
  }
  await clearTwoFactor(tx, user.id);
  await revokeAllSessions(tx, user.id, 'two_factor_reset');
  await audit(tx, systemContext(user.organizationId, 'cli'), {
    action: 'user.two_factor_reset',
    entityType: 'user',
    entityId: user.id,
    summary: `Two-step sign-in reset for ${user.fullName} from the server command line`,
  });
  console.log(`Two-step sign-in switched off for ${email}. They are signed out everywhere.`);
});
await closeDb();
