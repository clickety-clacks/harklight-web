import { ICONS } from './icon-data';

export function Icon({ name, class: cls }: { name: string; class?: string }) {
  const icon = ICONS[name];
  if (!icon) return null;
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      viewBox={icon.viewBox}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}
