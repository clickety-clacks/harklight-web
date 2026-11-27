import { expect, type Page } from '@playwright/test';

export async function observeOldHistory(page: Page) {
  async function openMessage(kind: string, id: string) {
    const title = `Synthetic ${kind}`;
    await page.getByTestId('row').filter({ hasText: title }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const pill = page.getByRole('button', { name: 'Copy message ID' });
    await expect(pill).toContainText(id);
    return { id, title };
  }

  const current = await openMessage('unanswered', 'i1');
  const [discussion, discussed] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/v2/items/i3/entries') &&
      response.request().method() === 'GET' && response.ok()),
    openMessage('discussed', 'i3'),
  ]);
  const { entries } = await discussion.json();
  expect(entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ entry_id: 'e1', text: 'Synthetic discussion' }),
  ]));
  const chat = page.locator('.chat-col').getByText('Synthetic discussion', { exact: true });
  await expect(chat).toBeVisible();
  const chatText = await chat.innerText();

  await page.getByRole('tab', { name: 'Replied' }).click();
  const answered = await openMessage('answered', 'i2');
  const answer = page.getByText('Synthetic answer', { exact: true });
  await expect(answer).toBeVisible();

  return {
    current,
    answered: { ...answered, answer: await answer.innerText() },
    discussed: { ...discussed, chat: { entry_id: 'e1', text: chatText } },
  };
}
