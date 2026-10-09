// components/DexCard.tsx — static per-row child (props only, no job: its list is state-derived, D4).
import type { DexCard as Card } from '../lib/types'
export default function DexCard(props: { card: Card }) {
  return (
    <a href={props.card.detailHref} data-dex={props.card.num} className="group flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-3 no-underline shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="self-start text-[11px] font-semibold tabular-nums text-slate-400">{props.card.num}</span>
      <img src={props.card.artwork} alt={props.card.displayName} loading="lazy" className="h-24 w-24 object-contain" />
      <div className="mt-1 text-sm font-semibold">{props.card.displayName}</div>
    </a>
  )
}
