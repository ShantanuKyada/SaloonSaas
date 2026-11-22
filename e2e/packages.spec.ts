import { expect, test } from '@playwright/test';
import { USERS, apiAs, arrangeBooking, signInAs, uniqueMobile, uniqueName, type Api } from './helpers';

/** A date `days` from today in the salon's time zone (YYYY-MM-DD). */
const day = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + days * 86_400_000));

async function servicesByName(api: Api): Promise<Map<string, string>> {
  const branches = await api.get<Array<{ id: string }>>('/branches');
  const services = await api.get<Array<{ id: string; name: string }>>('/services', { branchId: branches[0]!.id });
  return new Map(services.map((s) => [s.name, s.id]));
}

const code = () => `E${Date.now().toString(36).slice(-5).toUpperCase()}`;

test.describe('Packages and combos', () => {
  test('shows when a package is on sale, and only sells it within those dates', async ({ page, request }) => {
    const owner = await apiAs(request, USERS.owner);
    const services = await servicesByName(owner);
    const later = uniqueName('E2E Later Combo');
    const now = uniqueName('E2E Now Combo');
    await owner.post('/packages', { code: code(), name: later, price: 150000, validityDays: 30, items: [{ serviceId: services.get('Facial'), quantity: 1 }], saleStartsOn: day(5), saleEndsOn: day(20) });
    await owner.post('/packages', { code: code(), name: now, price: 150000, validityDays: 30, items: [{ serviceId: services.get('Facial'), quantity: 1 }], saleStartsOn: day(-1), saleEndsOn: day(20) });

    await signInAs(page, USERS.owner, '/services/packages');
    const laterCard = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: later }) });
    await expect(laterCard.getByText(/^On sale from /)).toBeVisible();
    await expect(laterCard.getByText(/^On sale .+ – .+/)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: now }) }).getByText('On sale', { exact: true })).toBeVisible();

    // Selling at the counter offers only what is on sale today
    const customer = await owner.post<{ id: string }>('/customers', { fullName: uniqueName('E2E Buyer'), mobile: uniqueMobile() });
    await page.goto(`/billing/new?customerId=${customer.id}`);
    await page.getByRole('button', { name: 'Sell package' }).click();
    const sell = page.getByRole('dialog', { name: 'Sell a package' });
    await expect(sell.getByText(now)).toBeVisible();
    await expect(sell.getByText(later)).toHaveCount(0);
  });

  test('an archived package can be found and brought back', async ({ page, request }) => {
    const owner = await apiAs(request, USERS.owner);
    const services = await servicesByName(owner);
    const name = uniqueName('E2E Archive Combo');
    await owner.post('/packages', { code: code(), name, price: 90000, validityDays: 30, items: [{ serviceId: services.get('Manicure'), quantity: 1 }] });

    await signInAs(page, USERS.owner, '/services/packages');
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await page.getByRole('dialog', { name: `Archive “${name}”?` }).getByRole('button', { name: 'Archive package' }).click();
    await expect(page.getByText(`${name} archived`)).toBeVisible();
    await expect(page.getByRole('heading', { name })).toHaveCount(0);

    await page.getByRole('radio', { name: 'Archived' }).click();
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name }) });
    await expect(card.getByText('Archived', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText(`${name} restored`)).toBeVisible();
    await page.getByRole('radio', { name: 'Current' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });
});

test.describe('Packages chosen at the visit', () => {
  test('a walk-in or booking can include a combo, which is sold on the visit’s bill and pays for its services', async ({ page, request }) => {
    const owner = await apiAs(request, USERS.owner);
    const services = await servicesByName(owner);
    const combo = uniqueName('E2E Visit Combo');
    const pkg = await owner.post<{ id: string }>('/packages', { code: code(), name: combo, price: 200000, validityDays: 60, items: [{ serviceId: services.get('Hair Spa'), quantity: 2 }, { serviceId: services.get('Facial'), quantity: 1 }] });
    const reception = await apiAs(request, USERS.rajkotReception);

    // Walk-in: choosing the combo adds its services, and says what is paid and what is left for later
    const walkIn = uniqueName('E2E Combo Walkin');
    await reception.post('/customers', { fullName: walkIn, mobile: uniqueMobile() });
    await signInAs(page, USERS.rajkotReception, '/walk-ins');
    await page.getByRole('button', { name: /^Walk-in/ }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Walk-in' });
    await drawer.getByRole('searchbox', { name: /Find customer/i }).fill(walkIn);
    await drawer.getByRole('button', { name: new RegExp(`^${walkIn}`) }).click();
    // A long list of combos is shortened; the new one may be behind "Show N more".
    const more = drawer.getByRole('button', { name: /^Show \d+ more$/ });
    if (await more.isVisible()) await more.click();
    await drawer.getByRole('button', { name: new RegExp(combo) }).click();
    await expect(drawer.getByRole('checkbox', { name: /^Hair Spa/ })).toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: /^Facial/ })).toBeChecked();
    await expect(drawer.getByText(`${combo} (₹2,000) is sold on this visit’s bill`)).toBeVisible();
    await expect(drawer.getByText(/Left for later visits: 1 × Hair Spa/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Add to queue' }).click();
    await expect(page.getByText(/is in the queue/)).toBeVisible();
    const [queued] = await reception.get<Array<{ id: string; estimatedAmount: number; items: Array<{ buyPackageName: string | null; price: number }> }>>('/appointments', { search: walkIn });
    expect(queued!.estimatedAmount).toBe(200000);
    expect(queued!.items.map((i) => [i.buyPackageName, i.price])).toEqual([[combo, 0], [combo, 0]]);
    await reception.post(`/appointments/${queued!.id}/status`, { status: 'cancelled', reason: 'E2E clean-up', notifyCustomer: false });

    // Billing the visit: the combo is on the bill, the facial uses one of its sessions
    const booking = await arrangeBooking(reception, { branchName: 'Glow Rajkot', serviceName: 'Facial', namePrefix: 'E2E Combo Booking' });
    const original = await reception.get<{ version: number; items: Array<{ serviceId: string; staffId: string; startAt: string }> }>(`/appointments/${booking.appointmentId}`);
    await reception.put(`/appointments/${booking.appointmentId}`, { version: original.version, notifyCustomer: false, items: original.items.map((i) => ({ serviceId: i.serviceId, staffId: i.staffId, startAt: i.startAt, buyPackageId: pkg.id })) });
    for (const status of ['checked_in', 'in_service', 'completed']) await reception.post(`/appointments/${booking.appointmentId}/status`, { status, notifyCustomer: false });

    await page.goto(`/billing/new?appointmentId=${booking.appointmentId}`);
    await expect(page.getByText(`Package: ${combo}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Facial (package: ${combo})`)).toBeVisible();
    await expect(page.getByText('Uses a session of the package bought on this bill: nothing to pay')).toBeVisible();
    await page.getByRole('button', { name: 'Create bill and take payment' }).click();
    await expect(page).toHaveURL(/\/billing\/bills\/[0-9a-f-]{36}/);

    const owned = await reception.get<Array<{ packageName: string; items: Array<{ serviceName: string; remaining: number }> }>>(`/customers/${booking.customerId}/packages`);
    expect(owned[0]!.packageName).toBe(combo);
    expect(Object.fromEntries(owned[0]!.items.map((i) => [i.serviceName, i.remaining]))).toEqual({ 'Hair Spa': 2, Facial: 0 });
  });
});
