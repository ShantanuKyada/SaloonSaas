import { expect, test } from '@playwright/test';
import { farDate, uniqueMobile, uniqueName } from './helpers';

// The customer-facing booking page: no sign-in, a phone-sized layout, only valid times, and a private link to manage the booking.

test.describe('Online booking', () => {
  test('a customer books online, then cancels from their private link', async ({ page }) => {
    const name = uniqueName('E2E Online');
    await page.goto('/book/glow');
    await expect(page.getByRole('heading', { name: 'Glow Salon Group' })).toBeVisible();

    // 1. Services (the branch picker appears because the salon has two)
    await page.getByLabel('Which branch?').selectOption({ label: 'Glow Rajkot, Rajkot' });
    await page.getByRole('button', { name: /Haircut \(Women\)/ }).click();
    await page.getByRole('button', { name: 'Choose a time' }).click();

    // 2. Time: pick a day well ahead, then the first time offered
    await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(3).click();
    const times = page.getByRole('group', { name: 'Choose a time' }).getByRole('button');
    await expect(times.first()).toBeVisible();
    await times.first().click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // 3. Details
    await page.getByLabel('Your name').fill(name);
    await page.getByLabel('Mobile number').fill(uniqueMobile());
    await page.getByRole('button', { name: 'Confirm booking' }).click();

    await expect(page.getByRole('heading', { name: 'You are booked in' })).toBeVisible();
    await page.getByRole('link', { name: 'Manage my booking' }).click();

    // The private page shows the booking and lets the customer cancel it
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByText('Haircut (Women)')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect(page.getByText('Your booking has been cancelled')).toBeVisible();
  });

  test('times beyond the booking window are never offered', async ({ request }) => {
    const branchesRes = await request.get('/api/v1/public/glow');
    const info = (await branchesRes.json()).data as { branches: Array<{ id: string }>; services: Array<{ id: string }> };
    const far = farDate(400, 1);
    const res = await request.get('/api/v1/public/glow/availability', { params: { branchId: info.branches[0]!.id, date: far, serviceIds: info.services[0]!.id } });
    const body = (await res.json()).data as { slots: unknown[]; beyondBookingWindowDays: number | null };
    expect(body.slots).toEqual([]);
    expect(body.beyondBookingWindowDays).toBeGreaterThan(0);
  });

  test('an unknown salon shows a calm message instead of an error page', async ({ page }) => {
    await page.goto('/book/not-a-real-salon');
    await expect(page.getByRole('heading', { name: 'Online booking is not available' })).toBeVisible();
  });

  test('a made-up manage link says the booking could not be found', async ({ page }) => {
    await page.goto('/book/manage/this-token-does-not-exist-at-all');
    await expect(page.getByRole('heading', { name: 'We could not find this booking' })).toBeVisible();
  });
});
