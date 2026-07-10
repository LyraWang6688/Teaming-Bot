import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 5000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const healthURL = `${baseURL}/feishu-config`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  workers: 1,
  webServer: {
    command: process.env.PLAYWRIGHT_SKIP_BUILD === '1'
      ? `pnpm exec next start --port ${port}`
      : `pnpm build && pnpm exec next start --port ${port}`,
    url: healthURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    timeout: 300_000,
    env: {
      ...process.env,
      NEXT_DISABLE_TURBOPACK: '1',
      PLAYWRIGHT_TEST: '1',
    },
  },
});
