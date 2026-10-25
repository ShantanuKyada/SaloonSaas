import { expect, test, type Locator } from '@playwright/test';
import { USERS, apiAs, signInAs, uniqueMobile, uniqueName } from './helpers';

/** The card of one customer on the walk-in board (other people may be queueing too). */
const cardOf = (region: Locator, name: string, button: string) => region.getByText(name).locator(`xpath=ancestor::*[.//button[normalize-space()="${button}"]][1]`);

test.describe('Walk-ins', () => {
  test('registers a walk-in, assigns a team member, starts and completes the service', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const branches = await api.get<Array<{ id: string }>>('/branches');
    const now = await api.get<{ staffAvailable: number }>('/dashboard/now', { branchId: branches[0]!.id });
    test.skip(now.staffAvailable === 0, 'Nobody is free to take a walk-in right now (the salon is closed or fully booked).');

    const name = uniqueName('E2E Walkin');
    await api.post('/customers', { fullName: name, mobile: uniqueMobile() });

    await signInAs(page, USERS.rajkotReception, '/walk-ins');
    await page.getByRole('button', { name: /^Walk-in/ }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Walk-in' });
    await drawer.getByRole('searchbox', { name: /Find customer/i }).fill(name);
    await drawer.getByRole('button', { name: new RegExp(name) }).first().click();
    await drawer.getByRole('button', { name: 'Haircut (Women)' }).first().click();
    await drawer.getByRole('button', { name: 'Add to queue' }).click();
    await expect(page.getByText(/is in the queue/)).toBeVisible();

    const waiting = page.getByRole('region', { name: 'Waiting' });
    await expect(waiting.getByText(name)).toBeVisible();
    await cardOf(waiting, name, 'Assign team member').getByRole('button', { name: 'Assign team member' }).click();
    const assign = page.getByRole('dialog', { name: new RegExp(`Assign team member · ${name}`) });
    // "Free until 12:30 PM" is not enough for a service that runs past a booking, so only take someone who is free for good.
    const free = await assign.getByRole('combobox').locator('option').filter({ hasText: /— Free$/ }).first().getAttribute('value');
    test.skip(!free, 'Nobody is free to take the walk-in right now.');
    await assign.getByRole('combobox').selectOption(free!);
    await expect(assign.getByRole('switch', { name: 'Start right now' })).toBeChecked();
    await assign.getByRole('button', { name: 'Start now' }).click();

    const inService = page.getByRole('region', { name: 'In service' });
    await expect(inService.getByText(name)).toBeVisible();
    await cardOf(inService, name, 'Complete').getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('region', { name: 'Completed' }).getByText(name)).toBeVisible();
    await expect(cardOf(page.getByRole('region', { name: 'Completed' }), name, 'Create bill').getByRole('button', { name: 'Create bill' })).toBeVisible();
  });

  test('a walk-in who is not assigned yet can be removed from the queue', async ({ page, request }) => {
    const api = await apiAs(request, USERS.rajkotReception);
    const branches = await api.get<Array<{ id: string }>>('/branches');
    const services = await api.get<Array<{ id: string; name: string }>>('/services', { branchId: branches[0]!.id });
    const name = uniqueName('E2E Queue');
    const customer = await api.post<{ id: string }>('/customers', { fullName: name, mobile: uniqueMobile() });
    const walkIn = await api.post<{ id: string }>('/walkins', { branchId: branches[0]!.id, customerId: customer.id, items: [{ serviceId: services.find((s) => s.name === 'Cleanup')!.id }], startNow: false });

    await signInAs(page, USERS.rajkotReception, '/walk-ins');
    const waiting = page.getByRole('region', { name: 'Waiting' });
    await cardOf(waiting, name, 'Remove').getByRole('button', { name: 'Remove' }).click();
    const confirm = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    await confirm.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect.poll(async () => (await api.get<{ status: string }>(`/appointments/${walkIn.id}`)).status).toBe('cancelled');
    await expect(waiting.getByText(name)).toHaveCount(0);
  });
});
