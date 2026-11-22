import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { USERS, apiAs, signInAs } from './helpers';

test.describe('Reports', () => {
  test('the owner runs the revenue report, regroups it by week and downloads it for Excel', async ({ page, request }) => {
    const api = await apiAs(request, USERS.owner);
    await signInAs(page, USERS.owner, '/reports');
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await page.getByRole('link', { name: /Daily revenue|Revenue/ }).first().click();
    await expect(page).toHaveURL(/\/reports\/revenue-daily/);

    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader').first()).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Total', exact: true })).toBeVisible();

    await page.getByRole('radio', { name: 'Week', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Week starting' })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    const exportRequest = page.waitForRequest((r) => r.url().includes('/reports/revenue-daily') && r.url().includes('format=csv'));
    await page.getByRole('button', { name: 'Download for Excel' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^revenue-daily_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await readFile(await download.path(), 'utf8');
    const lines = text.trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toContain('Week starting');
    expect(lines.at(-1)).toContain('Total');

    // The file and the API agree: same dates, same number of data rows (the first line is the header and the last the totals).
    // Asked exactly as the download was (dates, grouping and the branch chosen in the top bar).
    const [, from, to] = /_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(download.suggestedFilename())!;
    const sent = new URL((await exportRequest).url()).searchParams;
    expect([sent.get('from'), sent.get('to'), sent.get('groupBy')]).toEqual([from, to, 'week']);
    const json = await api.get<{ rows: unknown[] }>('/reports/revenue-daily', { from, to, groupBy: 'week', branchId: sent.get('branchId') ?? undefined });
    expect(lines.length - 2).toBe(json.rows.length);
  });

  test('a branch manager can only report on their own branch', async ({ page, request }) => {
    const manager = await apiAs(request, USERS.rajkotManager);
    const branches = await manager.get<Array<{ id: string; name: string }>>('/branches');
    expect(branches.map((b) => b.name)).toEqual(['Glow Rajkot']);

    await signInAs(page, USERS.rajkotManager, '/reports/revenue-branches');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Glow Ahmedabad')).toHaveCount(0);
  });

  test('a stylist cannot open reports', async ({ page }) => {
    await signInAs(page, USERS.stylist, '/reports');
    await expect(page.getByRole('heading', { name: 'This page is not part of your role' })).toBeVisible();
  });
});
