// components/TypeBadge.tsx — one helper-backed job; rendered per row on HomePage AND DetailPage (D4).
import { label, tint } from '../lib/format'
export default function TypeBadge(props: { type: string }) {
  return <span data-type={props.type} style={{ background: tint(props.type) }} className="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">{label(props.type)}</span>
}
