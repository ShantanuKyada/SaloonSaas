import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { USERS, apiAs, arrangeBooking, signInAs } from './helpers';

// Automated WCAG 2.1 A/AA checks (axe-core) on the screens people use every day, in light and dark themes.
// Automated checks find roughly a third of accessibility problems; keyboard and screen-reader use are covered in
// docs/PRODUCTION_READINESS.md. Any violation fails the build, so regressions cannot slip in.

const SCREENS: Array<{ name: string; user: string; path: string; ready: (page: Page) => Promise<void> }> = [
  { name: 'sign in', user: '', path: '/login', ready: async (p) => { await expect(p.getByRole('button', { name: 'Sign in' })).toBeVisible(); } },
  { name: 'owner dashboard', user: USERS.owner, path: '/dashboard', ready: async (p) => { await expect(p.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible(); } },
  { name: 'front desk', user: USERS.rajkotReception, path: '/desk', ready: async (p) => { await expect(p.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible(); } },
  { name: 'calendar', user: USERS.rajkotReception, path: '/appointments/calendar', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Calendar' })).toBeVisible(); } },
  { name: 'appointment list', user: USERS.rajkotReception, path: '/appointments?range=week', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Appointments' })).toBeVisible(); } },
  { name: 'walk-ins', user: USERS.rajkotReception, path: '/walk-ins', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Walk-ins' })).toBeVisible(); } },
  { name: 'customers', user: USERS.rajkotReception, path: '/customers', ready: async (p) => { await expect(p.getByRole('row').nth(1)).toBeVisible(); } },
  { name: 'new bill', user: USERS.rajkotReception, path: '/billing/new', ready: async (p) => { await expect(p.getByRole('heading', { name: 'New bill' })).toBeVisible(); } },
  { name: 'pending payments', user: USERS.owner, path: '/billing/pending', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Pending payments' })).toBeVisible(); } },
  { name: 'services', user: USERS.owner, path: '/services', ready: async (p) => { await expect(p.getByRole('row').nth(1)).toBeVisible(); } },
  { name: 'team', user: USERS.owner, path: '/staff', ready: async (p) => { await expect(p.getByRole('row').nth(1)).toBeVisible(); } },
  { name: 'service assignment grid', user: USERS.owner, path: '/staff/mapping', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Assign services' })).toBeVisible(); } },
  { name: 'reports', user: USERS.owner, path: '/reports/revenue-daily', ready: async (p) => { await expect(p.getByRole('table')).toBeVisible(); } },
  { name: 'settings', user: USERS.owner, path: '/settings?tab=booking', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Settings' })).toBeVisible(); } },
  { name: 'account security', user: USERS.owner, path: '/security', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Account security' })).toBeVisible(); } },
  { name: 'users and roles', user: USERS.owner, path: '/users', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Users and roles' })).toBeVisible(); } },
  { name: 'my day (phone)', user: USERS.stylist, path: '/my-day', ready: async (p) => { await expect(p.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible(); } },
  { name: 'online booking', user: '', path: '/book/glow', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Glow Salon Group' })).toBeVisible(); } },
];

const scan = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
};

for (const theme of ['light', 'dark'] as const) {
  test.describe(`Accessibility, ${theme} theme`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name} has no WCAG A/AA violations`, async ({ page }) => {
        await page.addInitScript((t) => { try { localStorage.setItem('salonos:theme', t); } catch { /* storage unavailable */ } }, theme);
        if (screen.user) await signInAs(page, screen.user, screen.path);
        else await page.goto(screen.path);
        await screen.ready(page);
        await page.waitForLoadState('networkidle');
        expect(await scan(page), `${screen.name} (${theme})`).toEqual([]);
      });
    }
  });
}

// Overlays are where focus handling and labelling usually go wrong, so scan them while open.
test.describe('Accessibility of dialogs and drawers', () => {
  test('new appointment drawer', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/desk');
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    await page.keyboard.press('n');
    const drawer = page.getByRole('dialog', { name: 'New appointment' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Haircut (Women)' }).first().click();
    expect(await scan(page), 'new appointment drawer').toEqual([]);
  });

  test('add customer dialog', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/customers');
    await page.getByRole('button', { name: 'Add customer' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Add customer' })).toBeVisible();
    expect(await scan(page), 'add customer dialog').toEqual([]);
  });

  test('appointment details drawer', async ({ page }) => {
    await signInAs(page, USERS.rajkotReception, '/appointments?range=all');
    await page.getByRole('row').nth(1).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await scan(page), 'appointment drawer').toEqual([]);
  });

  test('confirmation dialog before cancelling', async ({ page, request }) => {
    const booking = await arrangeBooking(await apiAs(request, USERS.rajkotReception), { branchName: 'Glow Rajkot', serviceName: 'Blow Dry' });
    await signInAs(page, USERS.rajkotReception, `/appointments/${booking.appointmentId}`);
    await page.getByRole('dialog').getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('dialog', { name: 'Cancel this appointment?' })).toBeVisible();
    expect(await scan(page), 'cancel dialog').toEqual([]);
  });

  test('keyboard shortcuts help', async ({ page }) => {
    await signInAs(page, USERS.owner, '/dashboard');
    await expect(page.getByRole('heading', { name: 'How is the salon doing?' })).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/i })).toBeVisible();
    expect(await scan(page), 'shortcuts dialog').toEqual([]);
  });
});
