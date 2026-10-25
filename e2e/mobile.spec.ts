import { expect, test, type Page } from '@playwright/test';
import { USERS, signInAs } from './helpers';

// Runs on a phone-sized screen (see the "mobile" project): nothing may scroll sideways and the main actions must be easy to hit.

const noSidewaysScroll = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal overflow in pixels').toBeLessThanOrEqual(0);
};

test.describe('On a phone', () => {
  test('a stylist sees today’s list first and can act with big buttons', async ({ page }) => {
    await signInAs(page, USERS.stylist, '/');
    await expect(page).toHaveURL(/\/my-day$/);
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    await noSidewaysScroll(page);
    const primary = page.getByRole('button', { name: /Start service|Complete service/ }).first();
    if (await primary.count()) {
      const box = (await primary.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('the front desk keeps the main actions in a bottom bar and the booking drawer fits the screen', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/desk');
    await noSidewaysScroll(page);
    const bar = page.getByRole('navigation', { name: 'Quick navigation' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'New appointment' }).click();
    const drawer = page.getByRole('dialog', { name: 'New appointment' });
    await expect(drawer).toBeVisible();
    const box = (await drawer.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    await expect(drawer.getByRole('button', { name: 'Confirm booking' })).toBeDisabled();
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(drawer).toBeHidden();
  });

  for (const path of ['/appointments', '/customers', '/billing/new', '/billing/bills', '/staff', '/reports', '/settings']) {
    test(`${path} has no sideways scrolling`, async ({ page }) => {
      await signInAs(page, USERS.owner, path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await noSidewaysScroll(page);
    });
  }

  test('online booking works with one thumb', async ({ page }) => {
    await page.goto('/book/glow');
    await expect(page.getByRole('heading', { name: 'Glow Salon Group' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByLabel('Which branch?').selectOption({ index: 0 });
    await page.getByRole('button', { name: /Haircut \(Women\)/ }).click();
    const next = page.getByRole('button', { name: 'Choose a time' });
    const box = (await next.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await noSidewaysScroll(page);
  });
});
