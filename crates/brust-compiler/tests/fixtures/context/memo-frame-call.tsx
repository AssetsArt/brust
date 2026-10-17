import { createContext, useContext, useMemo, useState } from 'react'
import { fmt } from './memo-fmt'

const Ctx = createContext<{ items: string[] }>({ items: [] })

// F329 W4 negative: the array holds a call of an imported function, which is not a plain combination of reads
function Group({ children }: { children?: React.ReactNode }) {
  const [value, setValue] = useState('')
  return (
    <Ctx.Provider value={{ items: useMemo(() => [fmt(value)], [value]) }}>
      <button type="button" onClick={() => setValue(value + 'x')}>
        +
      </button>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Count() {
  const c = useContext(Ctx)
  return <i>{c.items.length}</i>
}

export default function Page() {
  return (
    <Group>
      <Count />
    </Group>
  )
}
