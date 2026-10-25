import { expect, test } from '@playwright/test';
import { USERS, signInAs } from './helpers';

/** The front desk is ready for keys once its greeting is on screen (the shortcut handler is attached after sign-in finishes). */
const ready = async (page: import('@playwright/test').Page) => {
  await signInAs(page, USERS.rajkotReception, '/desk');
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
};

// Keyboard shortcuts for people who work at a desk all day: N new appointment, W walk-in, C customer, / search, ? help, Esc close.

test.describe('Keyboard shortcuts', () => {
  test('N opens a new appointment and Escape closes it', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('n');
    const drawer = page.getByRole('dialog', { name: 'New appointment' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('W opens a walk-in', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('w');
    await expect(page.getByRole('dialog', { name: 'Walk-in' })).toBeVisible();
  });

  test('/ jumps to search and finds a customer by name', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('/');
    const search = page.getByRole('combobox').or(page.getByRole('searchbox')).first();
    await expect(search).toBeFocused();
    await page.keyboard.type('E2E');
    await expect(page.getByRole('option').first()).toBeVisible();
  });

  test('? lists every shortcut', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/i })).toBeVisible();
  });

  test('shortcuts never fire while typing in a field', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/customers');
    const field = page.getByPlaceholder(/Search by name, mobile number/);
    await field.click();
    await page.keyboard.type('new walk');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(field).toHaveValue('new walk');
  });
});
