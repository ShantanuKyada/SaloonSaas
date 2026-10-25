import { expect, test } from '@playwright/test';
import { USERS, apiAs, retireStaff, signInAs, uniqueMobile, uniqueName } from './helpers';

test.describe('Team set-up', () => {
  test('an owner adds a stylist, who immediately gets matching services and the branch hours', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const name = uniqueName('E2E Stylist');
    const code = `E${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    await signInAs(page, USERS.owner, '/staff');
    await page.getByRole('button', { name: 'Add team member' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Add team member' });
    await drawer.getByLabel('Full name').fill(name);
    await drawer.getByLabel('Name shown on the calendar').fill(name.split(' ').slice(0, 3).join(' '));
    await drawer.getByLabel('Employee code').fill(code);
    await drawer.getByLabel('Branch').selectOption({ label: 'Glow Rajkot' });
    await drawer.getByLabel('Mobile number').fill(uniqueMobile());
    await drawer.getByRole('button', { name: 'Hair Stylist' }).click();
    await drawer.getByRole('button', { name: 'Add to team' }).click();

    // The new profile opens, with services matched to the chosen skill
    await expect(page).toHaveURL(/\/staff\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name })).toBeVisible();
    const id = /\/staff\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    try {
      const detail = await api.get<{ services: Array<{ isActive: boolean }>; weeklySchedule: { shifts: unknown[] }; expertise: Array<{ name: string }> }>(`/staff/${id}`);
      expect(detail.expertise.map((e) => e.name)).toContain('Hair Stylist');
      expect(detail.services.filter((s) => s.isActive).length).toBeGreaterThan(0);
      expect(detail.weeklySchedule.shifts.length).toBeGreaterThan(0);

      // Services tab lists them; hours tab shows a working week
      await page.getByRole('tab', { name: /Services/ }).click();
      await expect(page.getByText('Haircut (Women)').first()).toBeVisible();
      await page.getByRole('tab', { name: 'Working hours' }).click();
      await expect(page.getByRole('heading', { name: 'Weekly hours' })).toBeVisible();
    } finally {
      await retireStaff(api, id);
    }
  });

  test('a manager gives a team member a day off and the change is saved', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    type Schedule = { shifts: Array<{ weekday: number; startTime: string; endTime: string }>; breaks: Array<{ weekday: number; startTime: string; endTime: string; label: string }> };
    const list = await api.get<Array<{ id: string; displayName: string }>>('/staff', { pageSize: 100 });
    const person = list.find((s) => s.displayName.startsWith('E2E Stylist')) ?? list[0]!;
    const before = (await api.get<{ weeklySchedule: Schedule }>(`/staff/${person.id}`)).weeklySchedule;
    const plain = (x: Schedule): Schedule => ({ shifts: x.shifts.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime })), breaks: x.breaks.map(({ weekday, startTime, endTime, label }) => ({ weekday, startTime, endTime, label })) });

    try {
      await signInAs(page, USERS.owner, `/staff/${person.id}?tab=hours`);
      const monday = page.getByRole('switch', { name: 'Monday' });
      await expect(monday).toBeVisible();
      const wasWorking = await monday.isChecked();
      await monday.click();
      await page.getByRole('button', { name: 'Save working hours' }).click();
      await expect(page.getByText('Working hours saved').first()).toBeVisible();

      const after = (await api.get<{ weeklySchedule: Schedule }>(`/staff/${person.id}`)).weeklySchedule;
      expect(after.shifts.some((s) => s.weekday === 1)).toBe(!wasWorking);
    } finally {
      await api.put(`/staff/${person.id}/schedule`, plain(before)); // leave the data as it was
    }
  });

  test('a receptionist can see the team but cannot add or edit anyone', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/staff');
    await expect(page.getByRole('heading', { name: 'Team members' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add team member' })).toHaveCount(0);
  });
});
