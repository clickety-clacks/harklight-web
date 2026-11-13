// Screenshots of every screen, in light and dark, at the design's three
// widths, against the fake Server and the built site.
//
//   npm run build && node dev/screenshots.mjs [outDir]

import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { startFakeServer } from './fake-server.mjs';

const out = process.argv[2] ?? 'evidence/screens';
const WIDTHS = [
  ['wide', 1280, 800],
  ['medium', 900, 800],
  ['phone', 390, 844],
];
const MODES = ['dark', 'light'];

const server = await startFakeServer({ port: 0, vite: false, dist: 'dist', flags: ['attachments'] });
const base = `http://127.0.0.1:${server.port}`;
const control = (what, body = {}) =>
  fetch(`${base}/__fake/${what}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const shots = [];

async function page(width, height, mode) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: mode, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${base}/inbox`);
  await p.getByTestId('row').first().waitFor();
  await p.waitForFunction(() => document.fonts.status === 'loaded');
  return { ctx, p };
}

async function shot(p, name, layout, mode) {
  await p.waitForTimeout(250);
  const file = `${out}/${name}--${layout}--${mode}.png`;
  await p.screenshot({ path: file });
  shots.push(file);
}

const open = (p, title) => p.getByText(title).first().click();
const chatButton = (p) => p.getByRole('button', { name: /^Chat/ }).first();

for (const [layout, w, h] of WIDTHS) {
  for (const mode of MODES) {
    const phone = layout === 'phone';

    // Inbox
    await control('reset');
    let { ctx, p } = await page(w, h, mode);
    await shot(p, '01-inbox', layout, mode);
    await p.getByRole('tab', { name: 'Replied' }).click();
    await shot(p, '02-replied', layout, mode);
    await ctx.close();

    // An open request, and its chat
    await control('reset');
    ({ ctx, p } = await page(w, h, mode));
    await open(p, 'Which hotel should I book for Lisbon?');
    await shot(p, '03-message', layout, mode);
    if (layout !== 'wide') {
      await chatButton(p).click();
      await shot(p, '04-chat-open', layout, mode);
      await (phone ? p.getByRole('button', { name: 'Back to message' }) : p.getByRole('button', { name: 'Close chat' })).click();
    }
    // Answering: a choice picked, then writing a reply
    await p.getByRole('radio', { name: 'Hotel Avenida' }).click();
    await shot(p, '05-choice-picked', layout, mode);
    await p.getByRole('radio', { name: 'Reply' }).click();
    await p.getByRole('textbox', { name: 'Reply' }).fill('Book the Avenida, but only if breakfast is included');
    await shot(p, '06-writing-reply', layout, mode);
    await p.getByRole('button', { name: 'Send answer' }).click();
    await p.getByTestId('answered').waitFor();
    await shot(p, '07-answered', layout, mode);
    // The chat after answering is closed but readable
    if (layout !== 'wide') await chatButton(p).click();
    await p.getByText('This chat is closed').waitFor();
    await shot(p, '08-chat-closed', layout, mode);
    await ctx.close();

    // Message types
    await control('reset');
    ({ ctx, p } = await page(w, h, mode));
    for (const [title, name] of [
      ['Quarterly report is ready', '09-type-done'],
      ['Your week ahead', '10-type-info-seen'],
      ['The hosting card expires next month', '11-type-warning'],
      ['Production deploy failed', '12-type-error'],
      ['Approve the survey questions?', '13-type-request'],
    ]) {
      if (phone && (await p.getByRole('button', { name: 'Back to inbox' }).count())) {
        await p.getByRole('button', { name: 'Back to inbox' }).click();
      }
      await open(p, title);
      await shot(p, name, layout, mode);
    }
    await ctx.close();

    // Chat with files
    await control('reset');
    await control('reply', {
      sender_id: 'agent:research',
      message_id: 'lisbon',
      text: 'Here is the floor plan for the Avenida room.',
      files: [{ name: 'avenida-floor-plan.pdf', tier: 'inline', size: 412_000, sha256: '0'.repeat(64), data_base64: 'JVBERi0xLjQK' }],
    });
    ({ ctx, p } = await page(w, h, mode));
    await open(p, 'Which hotel should I book for Lisbon?');
    if (layout !== 'wide') await chatButton(p).click();
    await p.getByText('avenida-floor-plan.pdf').waitFor();
    await shot(p, '14-chat-file', layout, mode);
    await p.locator('input[type=file]').setInputFiles([
      { name: 'conference-schedule.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1_200_000, 'a') },
    ]);
    await p.getByRole('textbox', { name: 'Write a message' }).fill('Pick the one nearer the afternoon sessions.');
    await shot(p, '15-chat-attaching', layout, mode);
    await p.locator('.pending-files .rm').click();
    await p.locator('input[type=file]').setInputFiles([
      { name: 'venue-video.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(21_000_000, 'b') },
    ]);
    await p.getByRole('alert').waitFor();
    await shot(p, '16-chat-file-too-large', layout, mode);
    await ctx.close();

    // Settings and sign out
    await control('reset');
    ({ ctx, p } = await page(w, h, mode));
    await p.getByRole('button', { name: 'Settings' }).click();
    await p.getByText('Dana Reyes').waitFor();
    await shot(p, '17-settings', layout, mode);
    await p.getByRole('button', { name: 'Sign out' }).click();
    await shot(p, '18-sign-out-asks', layout, mode);
    await ctx.close();
  }
}

await browser.close();
await server.close();
console.log(`${shots.length} screenshots in ${out}`);
