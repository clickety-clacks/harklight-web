import type { ListOrder } from '../state/inbox';
import { Icon } from './Icon';

export function SortButton({ order, onOrder }: { order: ListOrder; onOrder: (order: ListOrder) => void }) {
  const posted = order === 'posted';
  const label = posted ? 'Posted' : 'Priority';
  return (
    <button type="button" class="sort-button" aria-label={`Sort: ${label}`} aria-pressed={posted}
      onClick={() => onOrder(posted ? 'priority' : 'posted')}>
      <Icon name="fyi-sort" />
      {label}
    </button>
  );
}
