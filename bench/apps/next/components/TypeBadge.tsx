import { LABEL, TINT } from '../lib/data'
export default function TypeBadge({ type }: { type: string }) {
  return <span data-type={type} style={{ background: TINT[type] ?? '#888888' }}>{LABEL[type] ?? type}</span>
}
