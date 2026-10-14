import { createContext, useContext, useTransition } from 'react'
import { formatPrice } from './lib/fmt'

const Ctx = createContext<{ price: number }>({ price: 0 })

// The Provider lives inside a component that stays a React island, so no frame can fill the consumer below.
function Shell({ children }: { children?: React.ReactNode }) {
  const [, start] = useTransition()
  return (
    <Ctx.Provider value={{ price: 5 }}>
      <button type="button" onClick={() => start(() => {})}>go</button>
      {children}
    </Ctx.Provider>
  )
}

function Label() {
  const c = useContext(Ctx)
  return <b>{formatPrice(c.price)}</b>
}

function Wrap() {
  return <i><Label /></i>
}

export default function Page() {
  return (
    <Shell>
      <Wrap />
    </Shell>
  )
}
