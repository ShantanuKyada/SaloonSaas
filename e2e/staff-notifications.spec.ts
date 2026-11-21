import { expect, test } from '@playwright/test';
import { USERS, apiAs, dateInDays, signInAs, uniqueMobile, uniqueName } from './helpers';

test.describe('Team members hear about their bookings', () => {
  test('the front desk books a stylist and it shows in the stylist’s bell', async ({ page, request }) => {
    const reception = await apiAs(request, USERS.rajkotReception);
    const branches = await reception.get<Array<{ id: string; name: string }>>('/branches');
    const branchId = branches.find((b) => b.name === 'Glow Rajkot')!.id;
    const services = await reception.get<Array<{ id: string; name: string }>>('/services', { branchId });
    const serviceId = services.find((s) => s.name === 'Haircut (Women)')!.id;
    const staff = await reception.get<Array<{ id: string; displayName: string }>>('/staff', { branchId });
    const rahul = staff.find((s) => s.displayName === 'Rahul')!.id;
    const name = uniqueName('E2E Bell');
    const customer = await reception.post<{ id: string }>('/customers', { fullName: name, mobile: uniqueMobile() });

    // Start from a quiet bell, then book Rahul (the stylist's login) at the first free time on a day ahead.
    const stylist = await apiAs(request, USERS.stylist);
    await stylist.post('/me/notifications/read', {});
    let booked = false;
    for (let d = 30; d < 70 && !booked; d += 1) {
      const date = dateInDays(d + Math.floor(Math.random() * 3));
      const free = await reception.get<{ staff: Array<{ staffId: string; slots: string[] }> }>('/scheduling/availability', { branchId, date, serviceIds: serviceId, staffId: rahul });
      const slot = free.staff.find((s) => s.staffId === rahul)?.slots[0];
      if (!slot) continue;
      await reception.post('/appointments', { branchId, customerId: customer.id, notifyCustomer: false, items: [{ serviceId, staffId: rahul, startAt: slot }] });
      booked = true;
    }
    expect(booked).toBe(true);

    await signInAs(page, USERS.stylist, '/my-day');
    const bell = page.getByRole('button', { name: /^Notifications, \d+\+? unread$/ });
    await expect(bell).toBeVisible();
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const notice = panel.getByRole('button', { name: new RegExp(`New booking: ${name}`) });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Haircut (Women)');

    // Opening it takes them to their bookings, where the new one is listed.
    await notice.click();
    await expect(page).toHaveURL(/\/my-appointments$/);
    await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();

    await page.getByRole('button', { name: /^Notifications/ }).click();
    const mark = page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: 'Mark all as read' });
    if (await mark.isVisible()) await mark.click();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  });

  test('people without a team-member profile see no bell', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/desk');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
  });
});
