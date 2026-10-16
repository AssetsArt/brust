import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
// F194: a block-scoped local leaks no name: after the block, `document` is the global object.
function tag(x: string) {
  if (x) {
    const document = x
  }
  return document
}

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag(label)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
