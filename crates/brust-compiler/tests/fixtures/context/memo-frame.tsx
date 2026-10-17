import { createContext, useContext, useMemo, useState } from 'react'

const Ctx = createContext<{ items: string[]; set: (v: string) => void }>({ items: [], set: () => {} })

// F329 (Radix ToggleGroupImplSingle): a frame value that is a `useMemo` over state, with an array in it
function Group({ children }: { children?: React.ReactNode }) {
  const [value, setValue] = useState('')
  return (
    <Ctx.Provider value={{ items: useMemo(() => (value ? [value] : []), [value]), set: setValue }}>
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
