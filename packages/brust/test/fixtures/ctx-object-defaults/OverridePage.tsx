import { createContext, type ReactNode, useContext } from 'react'

const Ctx = createContext({ a: 'dflt', b: 2, on: false })

function Show({ id }: { id: string }) {
  const { a, b } = useContext(Ctx)
  return <p data-testid={id}>{a}-{String(b)}</p>
}

function Mine({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={{ a: 'mine', b: 3, on: true }}>{children}</Ctx.Provider>
}

function OnlyA({ children }: { children: ReactNode }) {
  // React: the fields the value leaves out are undefined, not the default
  return <Ctx.Provider value={{ a: 'only', b: undefined, on: false }}>{children}</Ctx.Provider>
}

// F431: a Provider component in the page answers the children it is given; outside it, the defaults.
export default function OverridePage() {
  return (
    <main>
      <Show id="outside" />
      <Mine>
        <Show id="mine" />
      </Mine>
      <OnlyA>
        <Show id="only" />
      </OnlyA>
    </main>
  )
}
