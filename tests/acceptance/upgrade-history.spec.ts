import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { observeOldHistory } from '../history-observations';

test('read old message history through the upgraded fixture browser session', async ({ page }) => {
  const handoff = process.env.UPGRADE_HISTORY_HANDOFF_URL;
  const metadataPath = process.env.UPGRADE_HISTORY_METADATA;
  const reportPath = process.env.UPGRADE_HISTORY_REPORT;
  if (!handoff || !metadataPath || !reportPath) throw new Error('Missing isolated upgrade fixture inputs');

  const { client_build, server_version, server_commit, fixture_sha256 } =
    JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(client_build) || !/^[a-f0-9]{40}$/.test(server_commit) ||
      !/^[a-f0-9]{64}$/.test(fixture_sha256) || !/^\d+\.\d+\.\d+$/.test(server_version)) {
    throw new Error('Invalid isolated upgrade fixture pins');
  }

  const fixture = new URL(handoff);
  if (fixture.protocol !== 'https:') throw new Error('Upgrade history requires an isolated HTTPS fixture');
  try {
    await page.goto(handoff, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new Error('Could not open the isolated browser handoff');
  }
  // Match only the final address's origin and path. The handoff may include a secret.
  await page.waitForURL((url) => url.origin === fixture.origin && /^\/app\/(inbox)?\/?$/.test(url.pathname))
    .catch(() => { throw new Error('Isolated handoff did not reach Web'); });
  await expect(page.getByRole('tab', { name: 'Replied' })).toBeVisible();
  const observations = await observeOldHistory(page);
  writeFileSync(reportPath, JSON.stringify({
    platform: 'web',
    client_build, server_version, server_commit, fixture_sha256,
    outcome: 'pass',
    observations,
  }, null, 2) + '\n', { flag: 'wx' });
});
