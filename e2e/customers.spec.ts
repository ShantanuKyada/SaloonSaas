import { expect, test } from '@playwright/test';
import { USERS, apiAs, signInAs, uniqueMobile, uniqueName } from './helpers';

test.describe('Customers', () => {
  test('adds a customer, refuses the same mobile number twice, and finds them by number', async ({ page }) => {
    const name = uniqueName('E2E Customer');
    const mobile = uniqueMobile();
    await signInAs(page, USERS.rajkotReception, '/customers');
    await page.getByRole('button', { name: 'Add customer' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add customer' });
    await dialog.getByLabel('Full name').fill(name);
    await dialog.getByLabel('Mobile number').fill(mobile);
    await dialog.getByRole('button', { name: 'Add customer' }).click();

    // The list refreshes with the new customer at the top and a confirmation appears
    await expect(page.getByText(`${name} added`)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();

    // The same number again: pointed to the existing record instead of creating a duplicate
    await page.goto('/customers');
    await page.getByRole('button', { name: 'Add customer' }).first().click();
    const again = page.getByRole('dialog', { name: 'Add customer' });
    await again.getByLabel('Full name').fill('Someone Else Entirely');
    await again.getByLabel('Mobile number').fill(mobile);
    await again.getByRole('button', { name: 'Add customer' }).click();
    await expect(again.getByText(`This mobile number already belongs to ${name}`)).toBeVisible();
    await again.getByRole('button', { name: 'Open existing customer' }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name })).toBeVisible();

    // Search by the last digits of the number
    await page.goto('/customers');
    await page.getByPlaceholder(/Search by name, mobile number/).fill(mobile.slice(-6));
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
  });

  test('the customer page tells the story: visits, money and messages in plain tabs', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const rows = await api.get<Array<{ id: string; fullName: string }>>('/customers', { pageSize: 5 });
    const customer = rows[0]!;
    await signInAs(page, USERS.owner, `/customers/${customer.id}`);
    await expect(page.getByRole('heading', { name: customer.fullName })).toBeVisible();
    for (const tab of ['Visits', 'Bills & payments', 'Packages & offers', 'Messages', 'Preferences']) {
      await page.getByRole('tab', { name: new RegExp(tab) }).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Book appointment' })).toBeVisible();
  });

  test('customer groups show how many people match as the filter changes', async ({ page }) => {
    await signInAs(page, USERS.owner, '/customers/segments');
    await page.getByRole('button', { name: 'New group' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Customer group' });
    await drawer.getByLabel('No visit for at least (days)').fill('30');
    await expect(drawer.getByText(/customers? match/)).toBeVisible();
    const before = await drawer.getByText(/\d+ customers? match/).innerText();
    await drawer.getByLabel('No visit for at least (days)').fill('3000');
    await expect(drawer.getByText('0 customers match')).toBeVisible();
    expect(before).toMatch(/customers? match/);

    // Nonsense values are explained instead of leaving a stale number on screen
    await drawer.getByLabel('No visit for at least (days)').fill('99999');
    await expect(drawer.getByText(/could not count customers/i)).toBeVisible();
  });
});
