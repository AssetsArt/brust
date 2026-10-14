import { createContext } from 'react'
import { formatPrice } from './lib/fmt'
const LABELS: Record<string, string> = { a: 'A', b: 'B' }

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section data-l={label}>{children}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  const on = true
  const kind = 'a'
  const items = ['a', 'b']
  const x = 5
  return <Panel label="x">{LABELS[kind]}{items.length}{formatPrice(x)}</Panel>
}
