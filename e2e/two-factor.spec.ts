import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MANAGER_PASSWORD, SALON_PASSWORD, addManager, apiWith, enrolViaApi, nextTotp, provisionSalon, signInWith, totp, wrongTotp } from './helpers';

// Two-step sign-in with an authenticator app. Every test creates its own salon through the platform administrator, so
// turning the policy on or enrolling accounts never touches the demo salon that the other tests share.

const scan = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
};

/** Walks the on-screen set-up on the Account security page: key, first code, recovery codes, Done. */
async function setUpOnScreen(page: Page, options: { accessibility?: boolean } = {}): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn on two-step sign-in' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: /QR code/ })).toBeVisible();
  const secret = ((await dialog.getByTestId('setup-key').textContent()) ?? '').replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  if (options.accessibility) expect(await scan(page), 'set-up dialog').toEqual([]);

  // A wrong code is explained and nothing is switched on.
  await dialog.getByLabel('6-digit code').fill(wrongTotp(secret));
  await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText("didn't work");

  await dialog.getByLabel('6-digit code').fill(totp(secret));
  await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
  const codesDialog = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await expect(codesDialog).toBeVisible();
  const recoveryCodes = (await codesDialog.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents()).map((c) => c.trim());
  expect(recoveryCodes).toHaveLength(10);
  for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  if (options.accessibility) expect(await scan(page), 'recovery codes dialog').toEqual([]);

  // The codes are shown once, so the dialog cannot be dismissed until the person confirms they saved them.
  await expect(codesDialog.getByRole('button', { name: 'Done' })).toBeDisabled();
  await codesDialog.getByRole('checkbox', { name: /I have saved these codes/ }).check();
  await codesDialog.getByRole('button', { name: 'Done' }).click();
  return { secret, recoveryCodes };
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe('Two-step sign-in', () => {
  test('an owner turns it on from Account security, saves the recovery codes, and then needs a code to sign in', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.getByRole('button', { name: 'Account menu' }).click();
      await page.getByRole('menuitem', { name: 'Account security' }).click();
      await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
      await expect(page.getByText('Off', { exact: true })).toBeVisible();

      const { secret } = await setUpOnScreen(page, { accessibility: true });
      await expect(page.getByText('Recovery codes: 10 of 10 left')).toBeVisible();
      await expect(page.getByText('On', { exact: true })).toBeVisible();

      await signOut(page);
      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      // The password alone no longer opens the account: the page asks for the code.
      await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
      await page.getByLabel('6-digit code').fill(nextTotp(secret));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      // Signed out from Account security, so sign-in takes the person back there (the page they were last on).
      await expect(page).toHaveURL(/\/security$/);
      await expect(page.getByText('Recovery codes: 10 of 10 left')).toBeVisible();
    } finally {
      await salon.dispose();
    }
  });

  test('a wrong code is explained, and each recovery code works only once', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      const { secret, recoveryCodes } = await enrolViaApi(await apiWith(request, salon.ownerEmail, SALON_PASSWORD));

      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
      expect(await scan(page), 'code step').toEqual([]);

      await page.getByLabel('6-digit code').fill(wrongTotp(secret));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page.getByRole('alert')).toContainText("That code didn't work");
      await expect(page).toHaveURL(/\/login$/);

      await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
      await page.getByLabel('Recovery code').fill(recoveryCodes[0]!.toLowerCase());
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);

      // The same code does not work a second time; the next one does, and the count on Account security goes down.
      await signOut(page);
      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
      await page.getByLabel('Recovery code').fill(recoveryCodes[0]!);
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page.getByRole('alert')).toContainText("That code didn't work");
      await page.getByLabel('Recovery code').fill(recoveryCodes[1]!);
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/security');
      await expect(page.getByText('Recovery codes: 8 of 10 left')).toBeVisible();
    } finally {
      await salon.dispose();
    }
  });

  test('new recovery codes need the password and a code, and replace the old ones', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      const { secret, recoveryCodes } = await enrolViaApi(await apiWith(request, salon.ownerEmail, SALON_PASSWORD));
      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await page.getByLabel('6-digit code').fill(nextTotp(secret));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);

      await page.goto('/security');
      await page.getByRole('button', { name: 'Make new recovery codes' }).click();
      const dialog = page.getByRole('dialog', { name: 'Make new recovery codes' });
      await dialog.getByLabel('Your password').fill('Not-the-password-1');
      await dialog.getByLabel('Code from your authenticator app').fill(recoveryCodes[2]!);
      await dialog.getByRole('button', { name: 'Make new codes' }).click();
      await expect(dialog.getByRole('alert')).toContainText(/incorrect password/i);

      await dialog.getByLabel('Your password').fill(SALON_PASSWORD);
      await dialog.getByRole('button', { name: 'Make new codes' }).click();
      const fresh = page.getByRole('dialog', { name: 'Your new recovery codes' });
      await expect(fresh).toBeVisible();
      const codes = (await fresh.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents()).map((c) => c.trim());
      expect(codes).toHaveLength(10);
      expect(codes.filter((c) => recoveryCodes.includes(c))).toEqual([]);
      await fresh.getByRole('checkbox', { name: /I have saved these codes/ }).check();
      await fresh.getByRole('button', { name: 'Done' }).click();
      await expect(page.getByText('Recovery codes: 10 of 10 left')).toBeVisible();
    } finally {
      await salon.dispose();
    }
  });

  test('when the salon requires it, a manager is held at set-up until they finish it', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      const owner = await apiWith(request, salon.ownerEmail, SALON_PASSWORD);
      await enrolViaApi(owner); // owners are covered by the rule too, so the owner turns it on first
      await owner.patch('/organization/settings', { twoFactorRequirement: 'owners_and_managers' });
      const manager = await addManager(request, owner, salon);

      await signInWith(page, manager.email, MANAGER_PASSWORD);
      await expect(page).toHaveURL(/\/security$/);
      await expect(page.getByText('Set up two-step sign-in to continue')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Customers' })).toHaveCount(0);
      expect(await scan(page), 'required set-up screen').toEqual([]);

      // Nothing else opens until it is done, even by typing the address.
      await page.goto('/customers');
      await expect(page).toHaveURL(/\/security$/);

      await setUpOnScreen(page);
      await expect(page).toHaveURL(/\/today$/);

      // Required means it cannot be switched off from here.
      await page.goto('/security');
      await expect(page.getByText(/cannot be turned off/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Turn off two-step sign-in' })).toHaveCount(0);
    } finally {
      await salon.dispose();
    }
  });

  test('choosing "Required for owners" in Settings asks the owner to set theirs up straight away', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/settings?tab=privacy');
      await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
      await page.getByLabel('Who must use it').selectOption({ label: 'Required for owners' });
      await expect(page.getByText('You will be asked to set it up first')).toBeVisible();
      await page.getByRole('button', { name: 'Save changes' }).last().click();
      await expect(page).toHaveURL(/\/security$/);
      await expect(page.getByText('Set up two-step sign-in to continue')).toBeVisible();
    } finally {
      await salon.dispose();
    }
  });

  test('an owner can reset a colleague’s two-step sign-in from Users and roles', async ({ page, request }) => {
    const salon = await provisionSalon(request);
    try {
      const owner = await apiWith(request, salon.ownerEmail, SALON_PASSWORD);
      const manager = await addManager(request, owner, salon);
      await enrolViaApi(await apiWith(request, manager.email, MANAGER_PASSWORD));

      await signInWith(page, salon.ownerEmail, SALON_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/users');
      const row = page.getByRole('row').filter({ hasText: manager.fullName });
      await expect(row.getByText('On', { exact: true })).toBeVisible();
      await row.getByRole('button', { name: `Actions for ${manager.fullName}` }).click();
      await page.getByRole('menuitem', { name: 'Reset two-step sign-in' }).click();
      const dialog = page.getByRole('dialog', { name: /Reset .*two-step sign-in\?/ });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Reset two-step sign-in' }).click();
      await expect(page.getByText(/Two-step sign-in switched off/)).toBeVisible();
      await expect(row.getByText('Off', { exact: true })).toBeVisible();

      // The colleague can sign in with just a password again (apiWith fails if a code were still asked for).
      await apiWith(request, manager.email, MANAGER_PASSWORD);
    } finally {
      await salon.dispose();
    }
  });
});
