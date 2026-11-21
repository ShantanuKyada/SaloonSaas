import { expect, test } from '@playwright/test';
import { USERS, signInAs } from './helpers';

const NOT_FOUND = 'We could not find that page';

test.describe('Owner dashboard', () => {
  test('every "needs attention" alert opens a page that exists', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention).toBeVisible();
    const links = await attention.getByRole('link').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByText(NOT_FOUND), `${href} should be a real page`).toHaveCount(0);
    }
  });

  test('the overdue warning opens Pending payments', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    await page.getByRole('link', { name: /is overdue/ }).click();
    await expect(page.getByRole('heading', { name: 'Pending payments', level: 1 })).toBeVisible();
  });

  test('the figures open the pages behind them, and money still to collect is shown in red', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    const pending = page.getByRole('link', { name: /^Pending payments/ });
    await expect(pending).toHaveClass(/bg-danger-soft/);

    await page.getByRole('link', { name: /^Appointments today/ }).click();
    await expect(page).toHaveURL(/\/appointments\?range=today/);
    await expect(page.getByRole('heading', { name: 'Appointments', level: 1 })).toBeVisible();

    await page.goBack();
    await pending.click();
    await expect(page.getByRole('heading', { name: 'Pending payments', level: 1 })).toBeVisible();

    await page.goBack();
    await page.getByRole('link', { name: /^Team right now/ }).click();
    await expect(page.getByRole('heading', { name: 'Attendance', level: 1 })).toBeVisible();
  });

  test('each chart can be read as a table', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    const revenue = page.getByRole('region', { name: 'Revenue' });
    await revenue.getByRole('radio', { name: 'Table' }).click();
    await expect(revenue.getByRole('columnheader', { name: 'Bills' })).toBeVisible();
    const appointments = page.getByRole('region', { name: 'Appointments' });
    await appointments.getByRole('radio', { name: 'Table' }).click();
    await expect(appointments.getByRole('columnheader', { name: 'No-show' })).toBeVisible();
  });
});
