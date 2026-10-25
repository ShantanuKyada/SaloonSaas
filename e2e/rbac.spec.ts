import { expect, test } from '@playwright/test';
import { USERS, signInAs } from './helpers';

// Each role sees only what it is allowed to use, and the API refuses the rest even if someone types the address.

test.describe('Roles and permissions', () => {
  test('a stylist lands on “My day” and cannot open bills or settings', async ({ page }) => {
    await signInAs(page, USERS.stylist, '/');
    await expect(page).toHaveURL(/\/my-day$/);
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Bills' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);

    await page.goto('/billing/bills');
    await expect(page.getByRole('heading', { name: 'This page is not part of your role' })).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'This page is not part of your role' })).toBeVisible();
  });

  test('a receptionist starts at the front desk and has no user or role administration', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/');
    await expect(page).toHaveURL(/\/desk$/);
    await expect(page.getByRole('link', { name: 'Users & roles' })).toHaveCount(0);
    await page.goto('/users');
    await expect(page.getByRole('heading', { name: 'This page is not part of your role' })).toBeVisible();
  });

  test('a branch manager only ever sees their own branch', async ({ page }) => {
    await signInAs(page, USERS.rajkotManager, '/today');
    await expect(page.getByRole('heading', { name: 'Today at the salon' })).toBeVisible();
    await expect(page.getByText('Glow Rajkot').first()).toBeVisible();
    await expect(page.getByText('Glow Ahmedabad')).toHaveCount(0);
  });

  test('the API refuses another branch’s data to a branch user', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/desk');
    const token = await page.evaluate(async () => {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'salonos' }, credentials: 'include' });
      return (await r.json()).data.accessToken as string;
    });
    const mine = await page.request.get('/api/v1/branches', { headers: { Authorization: `Bearer ${token}` } });
    const branches = (await mine.json()).data as Array<{ id: string; name: string }>;
    expect(branches.map((b) => b.name)).toEqual(['Glow Rajkot']);

    const owner = await page.request.post('/api/v1/auth/login', { data: { identifier: USERS.owner, password: 'Welcome@2026' }, headers: { 'X-Requested-With': 'salonos' } });
    const ownerToken = (await owner.json()).data.accessToken as string;
    const all = (await (await page.request.get('/api/v1/branches', { headers: { Authorization: `Bearer ${ownerToken}` } })).json()).data as Array<{ id: string; name: string }>;
    const ahmedabad = all.find((b) => b.name === 'Glow Ahmedabad')!;
    const denied = await page.request.get('/api/v1/staff', { params: { branchId: ahmedabad.id }, headers: { Authorization: `Bearer ${token}` } });
    expect(denied.status()).toBe(403);
  });
});
