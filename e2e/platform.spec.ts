import { expect, test } from '@playwright/test';
import { SALON_PASSWORD, USERS, provisionSalon, signInAs, signInWith } from './helpers';

test.describe('Platform administration', () => {
  test('switches a feature off for one salon, opens that salon in support mode, and comes back', async ({ page, browser, request }) => {
    const salon = await provisionSalon(request);
    try {
      await signInAs(page, USERS.platform, '/platform');
      await page.getByRole('searchbox').fill(salon.code);
      await page.getByRole('table').getByText(`E2E Salon ${salon.code}`, { exact: true }).click();
      const drawer = page.getByRole('dialog', { name: `E2E Salon ${salon.code}` });

      // Reports off: gone for the salon's own owner.
      const reports = drawer.getByRole('switch', { name: /^Reports/ });
      await expect(reports).toBeChecked();
      await reports.click();
      await expect(page.getByText('Saved').first()).toBeVisible();
      await expect(reports).not.toBeChecked();
      const ownerPage = await (await browser.newContext()).newPage();
      await signInWith(ownerPage, salon.ownerEmail, SALON_PASSWORD);
      await expect(ownerPage).toHaveURL(/\/dashboard$/);
      await expect(ownerPage.getByRole('link', { name: 'Reports' })).toHaveCount(0);
      await ownerPage.goto('/reports');
      await expect(ownerPage.getByRole('heading', { name: 'This part of SalonOS is switched off for your salon' })).toBeVisible();

      // Support mode: the salon's own screens, with a banner and a way back.
      await drawer.getByRole('button', { name: 'Open salon (support mode)' }).click();
      await expect(page.getByText(`Support mode: E2E Salon ${salon.code}.`)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible();
      await page.goto('/customers');
      await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
      await expect(page.getByText(`Support mode: E2E Salon ${salon.code}.`)).toBeVisible(); // survives a reload
      await page.getByRole('button', { name: 'Back to platform' }).click();
      await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
      await expect(page.getByText('Support mode:')).toHaveCount(0);
    } finally {
      await salon.dispose();
    }
  });
});
