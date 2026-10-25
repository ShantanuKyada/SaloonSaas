import { passwordSchema } from '@salon/shared';
import { hashPassword } from '../core/passwords.js';
import { closeDb } from '../db/pool.js';
import { withSystem } from '../db/tenant.js';

// Bootstraps the first platform super admin:
//   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... PLATFORM_ADMIN_NAME=... npm run platform:admin -w @salon/api

const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
const fullName = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Admin';

if (!email || !passwordSchema.safeParse(password).success) {
  console.error('Set PLATFORM_ADMIN_EMAIL and a PLATFORM_ADMIN_PASSWORD of at least 10 characters with letters and numbers.');
  process.exit(1);
}

await withSystem(async (tx) => {
  const existing = await tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) {
    console.log(`A user with ${email} already exists; nothing to do.`);
    return;
  }
  await tx
    .insertInto('users')
    .values({ email, fullName, passwordHash: await hashPassword(password), isPlatformAdmin: true, organizationId: null, roleId: null })
    .execute();
  console.log(`Platform admin ${email} created.`);
});
await closeDb();
