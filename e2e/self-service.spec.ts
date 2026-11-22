import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { USERS, apiAs, farDate, uniqueMobile, uniqueName, type Api } from './helpers';

// Customer self-service: the private link in a booking message opens that booking and the customer's other visits,
// with "Book again" for what they had before.

async function bookFor(api: Api, branchId: string, serviceId: string, customerId: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const availability = await api.get<{ slots: Array<{ startAt: string; staffIds: string[] }> }>('/scheduling/availability', { branchId, date: farDate(7, 60), serviceIds: serviceId });
    const slot = availability.slots[0];
    if (!slot) continue;
    const a = await api.post<{ id: string }>('/appointments', { branchId, customerId, items: [{ serviceId, staffId: slot.staffIds[0], startAt: slot.startAt }], notifyCustomer: false });
    return a.id;
  }
  throw new Error('No free time for the test booking');
}

test.describe('Customer self-service', () => {
  test('from the private link a regular sees their visits and books their usual again', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const branch = (await api.get<Array<{ id: string; name: string }>>('/branches')).find((b) => b.name === 'Glow Rajkot')!;
    const service = (await api.get<Array<{ id: string; name: string }>>('/services', { branchId: branch.id })).find((s) => s.name === 'Haircut (Women)')!;
    const name = uniqueName('E2E Regular');
    const customer = await api.post<{ id: string }>('/customers', { fullName: name, mobile: uniqueMobile(), marketingConsent: false });

    // Two haircuts already done (her usual) and one booked.
    for (let i = 0; i < 2; i += 1) {
      const id = await bookFor(api, branch.id, service.id, customer.id);
      for (const status of ['checked_in', 'in_service', 'completed']) await api.post(`/appointments/${id}/status`, { status, notifyCustomer: false });
    }
    const upcoming = await bookFor(api, branch.id, service.id, customer.id);

    // The front desk copies her link (salons without WhatsApp set up send it by hand).
    const { url } = await api.post<{ url: string }>(`/appointments/${upcoming}/customer-link`);
    await page.goto(new URL(url).pathname);
    await expect(page.getByText(`Glow Rajkot · for ${name}`)).toBeVisible();

    const visits = page.getByRole('region', { name: 'Your visits' });
    await expect(visits.getByText('Your usual', { exact: true })).toBeVisible();
    await expect(visits.getByText(/Haircut \(Women\).* · Glow Rajkot · 2 visits/)).toBeVisible();
    await expect(visits.getByText('Nothing else is booked.')).toBeVisible();
    await expect(visits.getByRole('button', { name: 'Book again: Haircut (Women)' })).toHaveCount(2);

    const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations;
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    // Book the usual: it starts with the person she usually sees, and "Anyone" is one tap away.
    await visits.getByRole('button', { name: 'Book your usual' }).click();
    const dialog = page.getByRole('dialog', { name: 'Book again' });
    const people = dialog.getByRole('group', { name: 'Who would you like?' });
    await expect(people.locator('[aria-pressed="true"]')).not.toHaveText('Anyone');
    await people.getByRole('button', { name: 'Anyone' }).click();
    await dialog.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(3).click();
    const times = dialog.getByRole('group', { name: 'Choose a time' }).getByRole('button');
    await expect(times.first()).toBeVisible();
    await times.first().click();
    await dialog.getByRole('button', { name: 'Book this time' }).click();

    await expect(page.getByText(/You are booked in for/)).toBeVisible();
    await expect(visits.getByRole('button', { name: /^Change time of / })).toHaveCount(1);
    await expect(visits.getByText('Nothing else is booked.')).toHaveCount(0);
  });
});
