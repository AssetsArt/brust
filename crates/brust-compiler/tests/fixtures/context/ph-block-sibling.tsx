import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
// F194: a local of one branch is not in scope in the other: `v` there is an unbound global.
function tag(x: string) {
  if (x === 'y') {
    const v = 'a'
    return v
  } else {
    return v
  }
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
