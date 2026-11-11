import type { Leaf as L } from './types'

export default function Leaf({ l }: { l: L }) {
  return <span data-id={l.id}>{l.label}</span>
}
