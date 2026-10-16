import { useRef } from 'react'
import Fwd from './Fwd'

// Radix's BubbleInput `defaultChecked`: a never-written ref is the value `checked` had when this instance mounted.
export default function Bubble({ id, checked }: { id: string; checked: boolean }) {
  const snap = useRef(checked)
  // A composed handler next to it, as Radix has: the forwarder stays unlinked, so it binds through the spread.
  return <Fwd data-testid={id} aria-hidden tabIndex={-1} defaultChecked={snap.current} onClick={(e: { stopPropagation(): void }) => e.stopPropagation()} />
}
