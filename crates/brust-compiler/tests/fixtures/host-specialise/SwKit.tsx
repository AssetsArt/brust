import * as React from 'react'
import { createContext, useContext, useState } from 'react'
// Radix Switch's shape in app code: Root renders a Provider through a render prop called with its own context object
// (which holds setters), the trigger reads the context and hands it to a static button before the caller's rest, and
// the Thumb the caller passes travels in that rest (F298) and reads the context too.
type Ctx = { checked: boolean; setChecked: (f: (c: boolean) => boolean) => void; isFormControl: boolean }
const C = createContext<Ctx>({ checked: false, setChecked: () => {}, isFormControl: false })
function getState(checked: boolean) {
  return checked ? 'checked' : 'unchecked'
}
function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}
function Btn(props: React.ComponentPropsWithoutRef<'button'>) {
  return <button type="button" {...props} />
}
function KProvider({ children, render }: { children?: React.ReactNode; render?: (c: Ctx) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  const isFormControl = true
  const context = { checked, setChecked, isFormControl }
  return <C.Provider value={{ checked, setChecked, isFormControl }}>{isFunction(render) ? render(context) : children}</C.Provider>
}
function KTrigger({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const { checked, setChecked } = useContext(C)
  return <Btn role="switch" data-testid="box" data-state={getState(checked)} {...rest} onClick={() => setChecked((c) => !c)} />
}
export function KThumb() {
  const { checked } = useContext(C)
  return <span data-thumb={getState(checked)} />
}
export function KRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return <KProvider render={({ isFormControl }) => <><KTrigger {...rest} />{isFormControl && <i data-form="y" />}</>} />
}
