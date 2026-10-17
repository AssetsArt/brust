import { createContext, useContext, useMemo, useState } from 'react'

const Ctx = createContext<{ items: string[]; add: () => void }>({ items: [], add: () => {} })

// F329 part a (W4): a frame value that is a `useMemo` array over state, with a setter in the frame
function Group({ children }: { children?: React.ReactNode }) {
  const [value, setValue] = useState('')
  return (
    <Ctx.Provider value={{ items: useMemo(() => (value ? [value] : []), [value]), add: () => setValue('x') }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Count() {
  const c = useContext(Ctx)
  return <i>{c.items.length}</i>
}

function Add() {
  const c = useContext(Ctx)
  return (
    <button type="button" onClick={c.add}>
      add
    </button>
  )
}

export default function MemoFramePage() {
  return (
    <Group>
      <Count />
      <Add />
    </Group>
  )
}
