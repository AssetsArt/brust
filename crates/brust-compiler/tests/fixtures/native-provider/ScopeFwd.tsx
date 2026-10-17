import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// Radix's `Switch`: the component hands its own `__scopeX` prop, unchanged, to the consumer it renders under its Provider.
const Q = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function QProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <Q.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</Q.Provider>
}
function QTrigger(_: { __scopeQ?: unknown }) {
  const c = useContext(Q)
  return <button aria-pressed={c.on} onClick={c.flip} />
}
export function QRoot({ __scopeQ }: { __scopeQ?: unknown }) {
  return (
    <QProvider>
      <QTrigger __scopeQ={__scopeQ} />
    </QProvider>
  )
}
export function QRenamed({ __scopeQ: s }: { __scopeQ?: unknown }) {
  return (
    <QProvider>
      <QTrigger __scopeQ={s} />
    </QProvider>
  )
}
export function QDefaulted({ __scopeQ = {} }: { __scopeQ?: unknown }) {
  return (
    <QProvider>
      <QTrigger __scopeQ={__scopeQ} />
    </QProvider>
  )
}
