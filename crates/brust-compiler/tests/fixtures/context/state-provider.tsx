import { createContext, useContext, useState } from 'react'

const Ctx = createContext<{ open: boolean } | null>(null)

function Disclosure({ children }: { children?: React.ReactNode }) {
  const [open] = useState(false)
  return (
    <Ctx.Provider value={{ open }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Body() {
  const c = useContext(Ctx)!
  return c.open ? <p>open</p> : null
}

export default function Page() {
  return (
    <Disclosure>
      <Body />
    </Disclosure>
  )
}
