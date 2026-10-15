import { useCallback, useId, useRef, useState } from 'react'
import { compose } from 'some-package'
import { formatPrice } from './lib/fmt'
import { cn } from './lib/helpers'

const LABELS: Record<string, string> = { a: 'A', b: 'B' }
const KINDS = { a: 'a', b: 'b' } as const
const ORIENTATIONS = Object.values(KINDS)
// The parameter shares a name with the page's own `kind` (radix Separator's `orientation`): bindings are symbols.
function isValid(kind: string) {
  return ORIENTATIONS.includes(kind)
}

function Badge({ icon, label }: { icon?: React.ReactNode; label?: string }) {
  return <i title={label}>{icon}</i>
}

// An app function that only inspects the handler it is given.
function kindOf(f: unknown) {
  return typeof f
}

function Box({ style }: { style?: Record<string, string> }) {
  return <i style={style} />
}

export default function Page({ kind, price, title }: { kind: string; price: number; title: string }) {
  const items = ['a', 'b']
  const id = useId()
  const [n, setN] = useState(0)
  const onPick = useCallback(() => setN(n + 1), [n])
  const seen = useRef(0)
  const name = title.toUpperCase()
  return (
    <section>
      {title}
      {LABELS[kind]}
      {items.length}
      {formatPrice(price)}
      {name}
      <Badge icon={title} label={formatPrice(price)} />
      <Badge icon={LABELS[kind]} label={cn('a', title)} />
      <Badge label={isValid(kind) ? kind : 'none'} />
      <Badge label={id} />
      <Badge label={id} />
      <Badge label={kindOf(onPick)} />
      {/* A function handed to a package export is the package's to call (radix `composeEventHandlers`). */}
      <Badge label={compose(title, () => {
        seen.current = n
      })} />
      <Box style={{ ...LABELS, position: 'absolute' }} />
    </section>
  )
}
