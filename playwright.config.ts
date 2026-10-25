import { defineConfig, devices } from '@playwright/test';

// End-to-end tests drive the real web app against the real API and a seeded database (`npm run db:reset && npm run db:seed`).
// Start the stack yourself (`npm run dev`) or let Playwright start it: servers already running are reused.
// The API must run with RATE_LIMIT_MULTIPLIER (see .env.example) because tests sign in many times from one address.

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // E2E_BROWSER_CHANNEL=chrome runs against the Chrome already installed on the machine; CI installs Playwright's own Chromium.
  use: { baseURL, channel: process.env.E2E_BROWSER_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 800 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        { command: 'npm run dev -w @salon/api', url: 'http://localhost:4000/health', reuseExistingServer: true, timeout: 120_000, stdout: 'ignore' },
        { command: 'npm run dev -w @salon/web', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 120_000, stdout: 'ignore' },
      ],
});
