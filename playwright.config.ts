import { defineConfig, devices } from '@playwright/test';

const PORT = 4179;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node dev/fake-server.mjs --port ${PORT} --flags attachments --upload-cap 2000000`,
    url: `http://127.0.0.1:${PORT}/inbox`,
    reuseExistingServer: false,
  },
});
