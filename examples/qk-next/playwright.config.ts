import { defineConfig } from '@playwright/test';

/**
 * Browser tests for the production QueryKit demo.
 * Start the site with `next start` first. These tests do not launch `next dev`.
 */
const config = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.QK_SITE_URL ?? 'http://127.0.0.1:3001',
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }
  }
});

export default config;
