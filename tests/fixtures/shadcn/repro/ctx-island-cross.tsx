import { createContext } from 'react'
import { Reader } from './ctxlib/reader'

// Provider here is a DIFFERENT context object from ctxlib/ctx's: React's Reader reads ITS default.
const Local = createContext<{ label: string }>({ label: 'local-default' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Local.Provider value={{ label }}>
      <section>{children}</section>
    </Local.Provider>
  )
}

export default function Page() {
  return (
    <Panel label="from-panel">
      <Reader />
    </Panel>
  )
}
