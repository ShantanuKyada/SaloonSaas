import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, USERS, signInAs } from './helpers';

test.describe('Signing in', () => {
  test('a wrong password shows a clear message and keeps the person on the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email or mobile number').fill(USERS.owner);
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-it-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/email|mobile|password/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the owner signs in through the form and lands on the business dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email or mobile number').fill(USERS.owner);
    await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible();
  });

  test('a signed-out visitor is sent to sign in and returned to the page they asked for', async ({ page }) => {
    await page.goto('/billing/pending');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email or mobile number').fill(USERS.owner);
    await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/billing\/pending$/);
    await expect(page.getByRole('heading', { name: 'Pending payments' })).toBeVisible();
  });

  test('refreshing the browser keeps the session, and signing out ends it', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    await expect(page.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible();

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('two tabs opened at the same moment both stay signed in', async ({ context }) => {
    // Tabs share the refresh cookie and every renewal rotates it. If both tabs renewed at once, the server would see the
    // second request as an already-used (stolen) token, refuse it and end every session of that sign-in.
    const dashboard = (tab: Page) => tab.getByRole('heading', { name: 'How is the salon doing?' });
    const first = await context.newPage();
    await signInAs(first, USERS.owner, '/dashboard');
    await expect(dashboard(first)).toBeVisible();

    // Over a real network renewals take long enough for two tabs to overlap; on localhost they take a few milliseconds and
    // rarely do. So make the overlap certain: when two renewals are waiting they are sent together, and a renewal on its
    // own is sent after half a second.
    let waiting: Array<() => void> = [];
    await context.route('**/api/v1/auth/refresh', async (route) => {
      await new Promise<void>((send) => {
        waiting.push(send);
        if (waiting.length === 2) {
          waiting.forEach((release) => release());
          waiting = [];
        } else {
          setTimeout(() => {
            waiting = waiting.filter((release) => release !== send);
            send();
          }, 500);
        }
      });
      await route.continue();
    });
    const renewals: number[] = [];
    context.on('response', (r) => {
      if (r.url().endsWith('/auth/refresh')) renewals.push(r.status());
    });
    const second = await context.newPage();
    await Promise.all([first.reload(), second.goto('/dashboard')]);
    await expect(dashboard(first)).toBeVisible();
    await expect(dashboard(second)).toBeVisible();
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(renewals.filter((status) => status !== 200), 'every renewal succeeds').toEqual([]);

    // The sign-in is still alive afterwards, so later renewals keep working.
    await second.reload();
    await expect(dashboard(second)).toBeVisible();
  });

  test('unknown addresses show a friendly page, not a blank screen', async ({ page }) => {
    await signInAs(page, USERS.owner, '/this-page-does-not-exist');
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible();
  });
});
