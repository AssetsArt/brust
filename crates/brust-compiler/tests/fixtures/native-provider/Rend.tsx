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

// F266: the argument is a local const object (Radix's `render(context)`), read as its literal
export function RC({ children, render }: { children?: React.ReactNode; render?: R }) {
  const [on, setOn] = useState(false)
  const ctx = { on }
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{typeof render === 'function' ? render(ctx) : children}</C.Provider>
}
// F266: the same object, but a field of it is a computation: not a plain read, the Provider stays an island
export function RN({ render }: { render: R }) {
  const [on, setOn] = useState(false)
  const ctx = { on: !on }
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{render(ctx)}</C.Provider>
}
// F266: a const object spread into a component (Radix's `<Impl {...context}>`)
function Lbl({ text, tone }: { text: string; tone: string }) {
  return <span data-tone={tone}>{text}</span>
}
export function RS({ label }: { label: string }) {
  const [on, setOn] = useState(false)
  const attrs = { text: label, tone: 'x' }
  return <button aria-pressed={on} onClick={() => setOn((o) => !o)}><Lbl {...attrs} /></button>
}

// F269: the frame hands out a derived value over a prop and state (Radix's `useControllableState` value)
export function RD({ checked, children }: { checked?: boolean; children?: React.ReactNode }) {
  const [own, setOwn] = useState(false)
  const on = checked !== undefined ? checked : own
  return <C.Provider value={{ on, flip: () => setOwn((o) => !o) }}>{children}</C.Provider>
}

// F269: a boolean over a method of an element held in state (Radix's `isFormControl`): `!x` prints a boolean whatever `x` is
export function RF({ render }: { render: (s: { inForm: boolean }) => React.ReactNode }) {
  const [on, setOn] = useState(false)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const inForm = el ? !!el.closest('form') : true
  const ctx = { inForm }
  return <C.Provider value={{ on, flip: () => { setOn((o) => !o); setEl(document.body) } }}>{render(ctx)}</C.Provider>
}
// the method's own result is read (an element or null), not a boolean made of it: still not provably plain
export function RM({ render }: { render: (s: { inForm: unknown }) => React.ReactNode }) {
  const [on, setOn] = useState(false)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const inForm = el ? el.closest('form') : true
  const ctx = { inForm }
  return <C.Provider value={{ on, flip: () => { setOn((o) => !o); setEl(document.body) } }}>{render(ctx)}</C.Provider>
}
