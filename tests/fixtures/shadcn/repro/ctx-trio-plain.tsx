import { formatPrice } from './ctxlib/fmt'
const LABELS: Record<string, string> = { a: 'A', b: 'B' }

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  const kind = 'a'
  const items = ['a', 'b']
  const x = 5
  return <Wrap>{LABELS[kind]}{items.length}{formatPrice(x)}</Wrap>
}
