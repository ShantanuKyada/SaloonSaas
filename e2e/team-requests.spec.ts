import { expect, test } from '@playwright/test';
import { USERS, apiAs, dateInDays, signInAs, uniqueMobile, uniqueName } from './helpers';

test.describe('Team members: their own work, leave and time changes', () => {
  test('a stylist sees their schedule, asks for leave, and the manager approves it on the front desk', async ({ page, browser, request }) => {
    const stylist = await apiAs(request, USERS.stylist);
    // A date far ahead that no other test books, and without leave already (re-runs).
    const mine = await stylist.get<Array<{ startDate: string; status: string }>>('/me/leaves');
    let date = dateInDays(100 + Math.floor(Math.random() * 60));
    while (mine.some((l) => l.startDate === date && ['pending', 'approved'].includes(l.status))) date = dateInDays(100 + Math.floor(Math.random() * 60));
    const reason = uniqueName('Family function');

    await signInAs(page, USERS.stylist, '/my-schedule');
    await expect(page.getByRole('heading', { name: 'My schedule & leave' })).toBeVisible();
    await expect(page.getByText('Next two weeks')).toBeVisible();
    await page.getByRole('button', { name: 'Ask for leave' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ask for leave' });
    await dialog.getByLabel('From').fill(date);
    await dialog.getByLabel('To').fill(date);
    await dialog.getByLabel('Reason').fill(reason);
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Leave asked for').first()).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: reason });
    await expect(row.getByText('Waiting for approval')).toBeVisible();

    // The manager answers where they already work: the front desk.
    const managerPage = await (await browser.newContext()).newPage();
    await signInAs(managerPage, USERS.rajkotManager, '/desk');
    const requests = managerPage.getByRole('heading', { name: 'Requests from the team' }).locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
    const leave = requests.getByRole('listitem').filter({ hasText: reason });
    await leave.getByRole('button', { name: 'Approve' }).click();
    await expect(managerPage.getByText(/Leave approved/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('listitem').filter({ hasText: reason }).getByText('Approved')).toBeVisible();

    // Leave the stylist bookable for other tests.
    const manager = await apiAs(request, USERS.rajkotManager);
    const approved = (await stylist.get<Array<{ id: string; reason: string | null }>>('/me/leaves')).find((l) => l.reason === reason)!;
    await manager.patch(`/staff-leaves/${approved.id}`, { status: 'cancelled' });
  });

  test('a stylist asks to reschedule a booking and the front desk approves: the booking moves', async ({ page, browser, request }) => {
    const reception = await apiAs(request, USERS.rajkotReception);
    const branches = await reception.get<Array<{ id: string; name: string }>>('/branches');
    const branchId = branches.find((b) => b.name === 'Glow Rajkot')!.id;
    const services = await reception.get<Array<{ id: string; name: string }>>('/services', { branchId });
    const serviceId = services.find((s) => s.name === 'Haircut (Women)')!.id;
    const staff = await reception.get<Array<{ id: string; displayName: string }>>('/staff', { branchId });
    const rahul = staff.find((s) => s.displayName === 'Rahul')!.id;
    const name = uniqueName('E2E Move Me');
    const customer = await reception.post<{ id: string }>('/customers', { fullName: name, mobile: uniqueMobile() });

    // Book Rahul at the first time he is free on a quiet day ahead.
    let booked: { id: string; date: string; startAt: string } | null = null;
    for (let d = 20; d < 60 && !booked; d += 1) {
      const date = dateInDays(d + Math.floor(Math.random() * 3));
      const free = await reception.get<{ staff: Array<{ staffId: string; slots: string[] }> }>('/scheduling/availability', { branchId, date, serviceIds: serviceId, staffId: rahul });
      const slots = free.staff.find((s) => s.staffId === rahul)?.slots ?? [];
      if (slots.length < 3) continue;
      const a = await reception.post<{ id: string }>('/appointments', { branchId, customerId: customer.id, notifyCustomer: false, items: [{ serviceId, staffId: rahul, startAt: slots[0] }] });
      booked = { id: a.id, date, startAt: slots[0]! };
    }
    expect(booked).not.toBeNull();

    await signInAs(page, USERS.stylist, '/my-appointments');
    const card = page.getByRole('listitem').filter({ hasText: name });
    await card.getByRole('button', { name: 'Ask to reschedule' }).click();
    const dialog = page.getByRole('dialog', { name: `Ask to reschedule ${name}` });
    await dialog.getByLabel('Day').fill(booked!.date);
    const times = dialog.getByRole('radiogroup', { name: 'New time' }).getByRole('radio');
    await expect(times.first()).toBeVisible();
    await times.nth(1).click();
    const chosen = (await times.nth(1).textContent())!.trim();
    await dialog.getByLabel('Why?').fill('Training session in the morning');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Sent to the front desk')).toBeVisible();
    await expect(card.getByText(/Waiting for the front desk/)).toBeVisible();

    const deskPage = await (await browser.newContext()).newPage();
    await signInAs(deskPage, USERS.rajkotReception, '/desk');
    const move = deskPage.getByRole('listitem').filter({ hasText: name });
    await expect(move.getByText('Training session in the morning')).toBeVisible();
    await move.getByRole('button', { name: 'Approve' }).click();
    await expect(deskPage.getByText(new RegExp(`Moved ${name}`))).toBeVisible();

    const after = await reception.get<{ startAt: string; rescheduleCount: number }>(`/appointments/${booked!.id}`);
    expect(after.rescheduleCount).toBe(1);
    expect(after.startAt).not.toBe(booked!.startAt);
    expect(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(after.startAt)).toUpperCase().replace(/\s/g, '')).toBe(chosen.toUpperCase().replace(/\s/g, ''));
  });
});
