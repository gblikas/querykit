import { defineConfig } from '@playwright/test';

/**
 * Browser tests for the production QueryKit demo.
 *
 * Run `pnpm build` first; `pnpm test:site` does not build. Playwright then
 * starts `next start` on port 3001 unless a server is already listening
 * there, or skips the server when QK_SITE_URL points at a deployed site.
 * The bundled Chromium is used, so no branded Chrome install is needed.
 */
const siteUrl = process.env.QK_SITE_URL;
const localUrl = 'http://127.0.0.1:3001';

const config = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: siteUrl ?? localUrl,
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }
  },
  webServer: siteUrl
    ? undefined
    : {
        command: 'pnpm exec next start -p 3001',
        url: localUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
      }
});

export default config;
