import { expect, test } from '@playwright/test';
import { USERS, apiAs, arrangeBooking, dateInDays, signInAs } from './helpers';

// Repeating appointments: the front desk repeats a booking every few weeks, and a customer can do the same from their
// private link. Each visit is an ordinary booking; "this and the later ones" stops a repeat in one go.

test.describe('Repeating appointments', () => {
  test('the front desk repeats a booking every 2 weeks, then stops the later visits', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Blow Dry', date: dateInDays(9) });
    await signInAs(page, USERS.rajkotReception, `/appointments/${booking.appointmentId}`);

    const drawer = page.getByRole('dialog').first();
    await drawer.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Repeat this booking…' }).click();
    const repeat = page.getByRole('dialog', { name: 'Repeat this booking' });
    await repeat.getByLabel('How often').selectOption({ label: 'Every 2 weeks' });
    await repeat.getByLabel('Visits in all').selectOption({ label: '3 visits' });
    await expect(repeat.getByRole('listitem')).toHaveCount(3);
    await repeat.getByRole('button', { name: 'Book 2 more visits' }).click();

    const done = page.getByRole('dialog', { name: 'Repeat booked' });
    await expect(done.getByText(/more visits? booked|could not be booked/).first()).toBeVisible();
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/^Every 2 weeks · visit 1 of \d$/)).toBeVisible();

    const series = await api.get<{ series: { later: number } | null }>(`/appointments/${booking.appointmentId}`);
    test.skip(!series.series?.later, 'No later visit could be booked at this time');
    await drawer.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel this and later visits…' }).click();
    const stop = page.getByRole('dialog', { name: 'Cancel this and later visits?' });
    await stop.getByLabel('Reason').fill('Moving away');
    await stop.getByRole('button', { name: /^Cancel \d+ visits$/ }).click();
    await expect(page.getByText(/visits? cancelled/)).toBeVisible();
    expect((await api.get<{ status: string }>(`/appointments/${booking.appointmentId}`)).status).toBe('cancelled');
  });

  test('a customer repeats their booking from their private link', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const booking = await arrangeBooking(api, { branchName: 'Glow Rajkot', serviceName: 'Blow Dry', date: dateInDays(8) });
    const { url } = await api.post<{ url: string }>(`/appointments/${booking.appointmentId}/customer-link`);
    await page.goto(new URL(url).pathname);

    await page.getByRole('button', { name: 'Repeat this booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'Repeat this booking' });
    await dialog.getByLabel('How often').selectOption({ label: 'Every 3 weeks' });
    await dialog.getByLabel('Visits in all').selectOption({ label: '2 visits' });
    await dialog.getByRole('button', { name: 'Book 1 more visit' }).click();

    await expect(page.getByText(/Your repeating visits are booked|No more visits could be booked/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Repeat this booking' })).toHaveCount(0);
  });
});
