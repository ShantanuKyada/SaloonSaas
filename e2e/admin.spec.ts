import { expect, test } from '@playwright/test';
import { USERS, apiAs, signInAs, uniqueName } from './helpers';

test.describe('Users, roles and settings', () => {
  test('the owner creates a limited role and a user; the user must choose a new password and then sees only what the role allows', async ({ page, request, browser }) => {
    const api = await apiAs(request, USERS.owner);
    const roleName = uniqueName('E2E Desk');
    const userName = uniqueName('E2E Person');
    const email = `e2e.${Math.random().toString(36).slice(2, 9)}@glow.test`;
    const tempPassword = `Temp${Math.random().toString(36).slice(2, 8)}9x`;
    const newPassword = `Fresh${Math.random().toString(36).slice(2, 8)}7y`;
    let userId: string | null = null;

    try {
      // 1. A role that can only look at appointments and book them
      await signInAs(page, USERS.owner, '/users');
      await page.getByRole('tab', { name: 'Roles and permissions' }).click();
      await page.getByRole('button', { name: 'Create role' }).click();
      const roleDrawer = page.getByRole('dialog', { name: 'Create role' });
      await roleDrawer.getByLabel('Role name').fill(roleName);
      await roleDrawer.getByLabel('See all appointments').check();
      await roleDrawer.getByLabel('Book appointments').check();
      await roleDrawer.getByLabel('See customers').check();
      await roleDrawer.getByRole('button', { name: 'Create role' }).click();
      await expect(page.getByText('Role created')).toBeVisible();
      await expect(page.getByRole('heading', { name: roleName })).toBeVisible();

      // 2. A user with that role at one branch
      await page.getByRole('tab', { name: 'Users' }).click();
      await page.getByRole('button', { name: 'Add user' }).click();
      const userDrawer = page.getByRole('dialog', { name: 'Add user' });
      await userDrawer.getByLabel('Full name').fill(userName);
      await userDrawer.getByLabel('Email').fill(email);
      await userDrawer.getByLabel('Role').selectOption({ label: roleName });
      await userDrawer.getByLabel('Glow Rajkot').check();
      await userDrawer.getByLabel('Temporary password').fill(tempPassword);
      await userDrawer.getByRole('button', { name: 'Add user' }).click();
      await expect(page.getByText(/User added/)).toBeVisible();
      const users = await api.get<Array<{ id: string; email: string }>>('/users', { search: email });
      userId = users.find((u) => u.email === email)?.id ?? null;
      expect(userId).not.toBeNull();

      // 3. The new person signs in on their own device and is made to pick their own password
      const context = await browser.newContext();
      const other = await context.newPage();
      await other.goto('/login');
      await other.getByLabel('Email or mobile number').fill(email);
      await other.getByLabel('Password', { exact: true }).fill(tempPassword);
      await other.getByRole('button', { name: 'Sign in' }).click();
      await expect(other).toHaveURL(/\/change-password$/);
      await other.getByLabel('Current password').fill(tempPassword);
      await other.getByLabel('New password').fill(newPassword);
      await other.getByRole('button', { name: 'Save new password' }).click();
      await expect(other).toHaveURL(/\/desk$/);

      // 4. They see only what the role allows
      await expect(other.getByRole('link', { name: 'Calendar' })).toBeVisible();
      await expect(other.getByRole('link', { name: 'Bills' })).toHaveCount(0);
      await expect(other.getByRole('link', { name: 'Reports' })).toHaveCount(0);
      await other.goto('/billing/bills');
      await expect(other.getByRole('heading', { name: 'This page is not part of your role' })).toBeVisible();
      await context.close();
    } finally {
      if (userId) await api.patch(`/users/${userId}`, { status: 'disabled' });
    }
  });

  test('a wrong current password is explained and does not change anything', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/change-password');
    await page.getByLabel('Current password').fill('not-the-password-1');
    await page.getByLabel('New password').fill('Another-Good-Pass-9');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText(/current password/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/change-password$/);
  });

  test('the owner changes a booking setting and it is saved, then restores it', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const before = await api.get<{ slotIntervalMinutes: number }>('/organization/settings');
    const target = before.slotIntervalMinutes === 15 ? '30' : '15';
    try {
      await signInAs(page, USERS.owner, '/settings?tab=booking');
      await page.getByLabel('Time slots every').selectOption(target);
      await page.getByRole('button', { name: 'Save changes' }).first().click();
      await expect(page.getByText('Settings saved')).toBeVisible();
      const after = await api.get<{ slotIntervalMinutes: number }>('/organization/settings');
      expect(String(after.slotIntervalMinutes)).toBe(target);
    } finally {
      await api.patch('/organization/settings', { slotIntervalMinutes: before.slotIntervalMinutes });
    }
  });

  test('the activity log records the change with who made it', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const before = await api.get<{ slotIntervalMinutes: number }>('/organization/settings');
    await api.patch('/organization/settings', { slotIntervalMinutes: before.slotIntervalMinutes === 10 ? 15 : 10 });
    await api.patch('/organization/settings', { slotIntervalMinutes: before.slotIntervalMinutes });

    await signInAs(page, USERS.owner, '/activity');
    await page.getByLabel('Area').selectOption({ label: 'Salon settings' });
    const row = page.getByRole('row').filter({ hasText: /Hitesh Shah/ }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('dialog')).toContainText('organization.settings_updated');
    await expect(page.getByRole('dialog')).toContainText('Slot interval minutes');
  });
});
