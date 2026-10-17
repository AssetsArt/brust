import * as React from 'react'

// F328c (ruling on note 84cd6abb, option a): a state Provider whose items each carry a `useId`. The server numbers the ids
// through the caller's records (the Provider clone is inlined in its caller), so every id is the one React prints.
const Ctx = React.createContext<{ current: string | null; setCurrent: (id: string) => void }>({ current: null, setCurrent: () => {} })

function Group({ children }: { children?: React.ReactNode }) {
  const [current, setCurrent] = React.useState<string | null>(null)
  return (
    <Ctx.Provider value={{ current, setCurrent }}>
      <div role="group" data-current={current ?? 'none'}>
        {children}
      </div>
    </Ctx.Provider>
  )
}

function Item({ label }: { label: string }) {
  const id = React.useId()
  const c = React.useContext(Ctx)
  return (
    <button id={id} type="button" tabIndex={c.current === id ? 0 : -1} onFocus={() => c.setCurrent(id)}>
      {label}
    </button>
  )
}

export default function RovingPage() {
  return (
    <main>
      <Group>
        <Item label="a" />
        <Item label="b" />
      </Group>
      <Group>
        <Item label="c" />
      </Group>
    </main>
  )
}
