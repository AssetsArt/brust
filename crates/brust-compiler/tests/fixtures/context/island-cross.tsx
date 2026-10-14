import { createContext } from 'react'
import { Reader } from './lib/reader'

export const Ctx = createContext<{ label: string }>({ label: 'default' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return (
    <Panel label="from-panel">
      <Reader />
    </Panel>
  )
}
