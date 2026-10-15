import { useId } from 'react'
import { formatPrice } from './lib/fmt'
import { cn } from './lib/helpers'

const LABELS: Record<string, string> = { a: 'A', b: 'B' }
const ORIENTATIONS = ['a', 'b']
function isValid(o: string) {
  return ORIENTATIONS.includes(o)
}

function Badge({ icon, label }: { icon?: React.ReactNode; label?: string }) {
  return <i title={label}>{icon}</i>
}

function Box({ style }: { style?: Record<string, string> }) {
  return <i style={style} />
}

export default function Page({ kind, price, title }: { kind: string; price: number; title: string }) {
  const items = ['a', 'b']
  const id = useId()
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
      <Box style={{ ...LABELS, position: 'absolute' }} />
    </section>
  )
}
