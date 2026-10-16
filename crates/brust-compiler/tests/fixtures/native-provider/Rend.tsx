import * as React from 'react'
import { createContext, useContext, useState } from 'react'

const C = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
type R = (s: { on: boolean }) => React.ReactNode

// guarded by typeof, falling back to children
export function RG({ children, render }: { children?: React.ReactNode; render?: R }) {
  const [on, setOn] = useState(false)
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{typeof render === 'function' ? render({ on }) : children}</C.Provider>
}
// a bare call
export function RB({ render }: { render: R }) {
  const [on, setOn] = useState(false)
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{render({ on })}</C.Provider>
}
// the prop is used another way besides the call
export function RU({ render }: { render: R }) {
  const [on, setOn] = useState(false)
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}><i data-r={String(render)} />{render({ on })}</C.Provider>
}
// the argument is a computation
export function RK({ render }: { render: R }) {
  const [on, setOn] = useState(false)
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{render({ on: !on })}</C.Provider>
}
export function RT({ children }: { children?: React.ReactNode }) {
  const c = useContext(C)
  return <button aria-pressed={c.on} onClick={c.flip}>{children}</button>
}

// the helper form Radix uses: isFunction(render) ? render(ctx) : children
function isFunction(value: unknown): value is (...a: never[]) => unknown {
  return typeof value === 'function'
}
export function RH({ children, render }: { children?: React.ReactNode; render?: R }) {
  const [on, setOn] = useState(false)
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{isFunction(render) ? render({ on }) : children}</C.Provider>
}
