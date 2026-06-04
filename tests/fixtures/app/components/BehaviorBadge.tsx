// Native directive component (Spec B): a co-located `export const behavior`
// (react-free client logic) + a JSX `export default`. The compiler AUTO-INJECTS
// `x-data="<camelCase>_<8hex>"` onto the root element of this inlined
// `<BehaviorBadge native/>` because the source has `export const behavior` and
// the author wrote NO literal x-data (author-wins escape not taken). The injected
// x-data value MUST equal the built `<name>.directive.js` chunk filename — the
// single-name contract this fixture exercises end-to-end.
import { signal } from 'brustjs/store'

export const behavior = ({ el }: { el: HTMLElement }) => {
  const n = signal(0)
  return {
    n,
    bump() {
      n.set(n() + 1)
      el.setAttribute('data-bumped', String(n()))
    },
  }
}

export default function BehaviorBadge({ label }: { label: string }) {
  return (
    <span class="bbadge" x-on-click="bump">
      {label}
    </span>
  )
}
