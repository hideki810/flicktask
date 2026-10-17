import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // WebKit の代わりに Chromium で iPhone の画面サイズ・タッチ操作を再現する
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npx vite build && rm -rf .wrangler/state/e2e && npx wrangler d1 migrations apply DB --local --env e2e --persist-to .wrangler/state/e2e && npx wrangler dev --env e2e --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/state/e2e`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
