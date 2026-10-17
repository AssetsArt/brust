import * as React from 'react'
import { createContext, useState } from 'react'
// F351: shapes of a render prop the Provider's clone cannot take (the call site keeps the island), and the one that it can.
type Ctx = { checked: boolean; setChecked: (f: (c: boolean) => boolean) => void }
const C = createContext<Ctx>({ checked: false, setChecked: () => {} })
function build(checked: boolean, setChecked: Ctx['setChecked']): Ctx {
  return { checked, setChecked }
}
// the argument is a local object built by a call: not an object literal
export function PNotLiteral({ render }: { render: (c: Ctx) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  const context = build(checked, setChecked)
  return <C.Provider value={{ checked, setChecked }}>{render(context)}</C.Provider>
}
// an argument that is a computation, not a plain read
export function PComputed({ render }: { render: (c: Ctx) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  return <C.Provider value={{ checked, setChecked }}>{render({ checked: !checked, setChecked })}</C.Provider>
}
// the prop is called twice
export function PTwice({ render }: { render: (c: Ctx) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  const context = { checked, setChecked }
  return <C.Provider value={{ checked, setChecked }}>{render(context)}{render(context)}</C.Provider>
}
// the taken shape: a local object literal, the body reads its SETTER member
export function PSetter({ render }: { render: (c: Ctx) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  const context = { checked, setChecked }
  return <C.Provider value={{ checked, setChecked }}>{render(context)}</C.Provider>
}
