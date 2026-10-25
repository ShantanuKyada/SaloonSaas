import { expect, test } from '@playwright/test';
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

  test('unknown addresses show a friendly page, not a blank screen', async ({ page }) => {
    await signInAs(page, USERS.owner, '/this-page-does-not-exist');
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible();
  });
});
