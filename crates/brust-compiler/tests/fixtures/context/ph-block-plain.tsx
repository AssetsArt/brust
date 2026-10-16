import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
// F194: block-scoped locals read inside their own block, and one name declared in two sibling blocks, stay plain.
function tag(x: string) {
  if (x === 'y') {
    const v = x + '!'
    return v
  } else {
    const v = x + '?'
    {
      const w = v + v
      return w
    }
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
