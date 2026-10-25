import { expect, test } from '@playwright/test';
import { USERS, apiAs, signInAs, uniqueName } from './helpers';

test.describe('Messages', () => {
  test('editing a template shows a live preview and refuses placeholders that do not exist', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const templates = await api.get<Array<{ id: string; eventType: string; channel: string; body: string; subject: string | null; isActive: boolean; providerTemplateName: string | null }>>('/notification-templates');
    const original = templates.find((t) => t.eventType === 'appointment_confirmation' && t.channel === 'sms')!;

    try {
      await signInAs(page, USERS.owner, '/notifications/templates');
      const group = page.getByRole('heading', { name: 'Booking confirmation', exact: true }).locator('xpath=ancestor::*[.//li][1]');
      const card = group.locator('li').filter({ has: page.getByText('SMS', { exact: true }) });
      await card.getByRole('button', { name: 'Edit' }).click();
      const drawer = page.getByRole('dialog');
      const message = drawer.getByRole('textbox', { name: 'Message' });
      await message.fill('Hi {{customerName}}, see you at {{time}}. {{nonsense}}');
      await expect(drawer.getByText('Unknown placeholder')).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Save template' })).toBeDisabled();

      await message.fill('Hi {{customerName}}, see you at {{time}} (E2E).');
      await expect(drawer.getByText(/Hi Meera, see you at 5:00 PM \(E2E\)\./)).toBeVisible();
      await drawer.getByRole('button', { name: 'Save template' }).click();
      await expect(page.getByText('Template saved')).toBeVisible();
      const after = (await api.get<typeof templates>('/notification-templates')).find((t) => t.id === original.id)!;
      expect(after.body).toBe('Hi {{customerName}}, see you at {{time}} (E2E).');
    } finally {
      // Put back every template whose wording differs from before the test, whichever one was edited
      for (const now of await api.get<typeof templates>('/notification-templates')) {
        const was = templates.find((t) => t.id === now.id)!;
        if (now.body !== was.body) await api.put(`/notification-templates/${was.id}`, { subject: was.subject, body: was.body, isActive: was.isActive, providerTemplateName: was.providerTemplateName });
      }
    }
  });

  test('the delivery log filters by status and explains a failed message', async ({ page }) => {
    await signInAs(page, USERS.owner, '/notifications/logs');
    await expect(page.getByRole('heading', { name: 'Message delivery' })).toBeVisible();
    await page.getByLabel('Status').selectOption({ label: 'Failed' });
    const rows = page.getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
    await rows.nth(1).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('Failed').first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('a campaign is saved as a draft for a customer group and counts who would receive it', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    const name = uniqueName('E2E Campaign');
    await signInAs(page, USERS.owner, '/notifications/campaigns');
    await page.getByRole('button', { name: 'New campaign' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'New campaign' });
    await drawer.getByLabel('Campaign name').fill(name);
    await expect(drawer.getByText(/customers? will receive this by/)).toBeVisible();
    await drawer.getByRole('textbox', { name: 'Message' }).fill('Hi {{customerName}}, a little offer from {{salonName}} just for you.');
    await drawer.getByRole('button', { name: 'Save campaign' }).click();
    await expect(page.getByText(/Campaign saved/)).toBeVisible();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Not sent yet').first()).toBeVisible();

    // Cancel it so the list does not fill up with test drafts
    const campaigns = await api.get<Array<{ id: string; name: string }>>('/campaigns');
    const created = campaigns.find((c) => c.name === name)!;
    await api.post(`/campaigns/${created.id}/cancel`);
  });
});
