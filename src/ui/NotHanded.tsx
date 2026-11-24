import { Icon } from './Icon';

/** The message or answer was not handed to the agent. The text says so, not the icon or colour alone. */
export function NotHanded({ quiet }: { quiet?: boolean }) {
  return (
    <span class={quiet ? 'turn-st' : 'turn-st turn-st--bad'} data-testid="not-handed">
      <Icon name="warn" />
      Not handed to the agent
    </span>
  );
}
