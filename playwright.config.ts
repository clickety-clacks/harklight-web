import { defineConfig, devices } from '@playwright/test';

// E2E_PORT moves both fake Servers, so two checkouts can run the suite at once.
const PORT = Number(process.env.E2E_PORT ?? 4179);
/** The same suite with the client on client API v2 (flags.clientApiV2). */
const V2_PORT = PORT + 1;
const SERVER = 'node dev/fake-server.mjs --upload-cap 2000000';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}` }, testIgnore: /v2\.spec\.ts/ },
    { name: 'chromium-v2', use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${V2_PORT}` } },
  ],
  webServer: [
    {
      command: `${SERVER} --port ${PORT} --flags attachments,answer-forms`,
      url: `http://127.0.0.1:${PORT}/inbox`,
      reuseExistingServer: false,
    },
    {
      command: `${SERVER} --port ${V2_PORT} --flags attachments,answer-forms,client-api-v2`,
      url: `http://127.0.0.1:${V2_PORT}/inbox`,
      reuseExistingServer: false,
    },
  ],
});
