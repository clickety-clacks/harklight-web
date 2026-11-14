import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config';
import { Settings } from '../../src/ui/Settings';

function shown(overrides: Record<string, string>) {
  const el = document.createElement('div');
  render(
    <Settings config={mergeConfig(DEFAULT_CONFIG, overrides)} displayName="Dana" connection="connected" onBack={() => {}} onSignOut={() => {}} />,
    el,
  );
  return el.textContent ?? '';
}

describe('settings links', () => {
  it('shows every link with the hosted defaults', () => {
    const t = shown({});
    for (const s of ['Plan and billing', 'Devices', 'Connect an agent', 'Sign out']) expect(t).toContain(s);
  });
  it('hides a link whose path a deployment leaves empty', () => {
    const t = shown({ accountUrl: '' });
    expect(t).not.toContain('Plan and billing');
    expect(t).toContain('Devices');
  });
});
