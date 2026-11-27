import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/acceptance',
  reporter: 'list',
  retries: 0,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
