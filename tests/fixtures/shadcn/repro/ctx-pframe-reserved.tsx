import { createContext, useContext } from 'react'
const Ctx = createContext<{ label: string } | null>(null)

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

function Badge({ __ctx_Ctx_label }: { __ctx_Ctx_label?: string }) {
  return <i>{__ctx_Ctx_label}</i>
}

export default function Page() {
  return (
    <Panel label="x">
      <Badge __ctx_Ctx_label="forged" />
    </Panel>
  )
}
