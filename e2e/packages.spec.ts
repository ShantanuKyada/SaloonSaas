import { expect, test } from '@playwright/test';
import { USERS, apiAs, signInAs, uniqueMobile, uniqueName, type Api } from './helpers';

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
