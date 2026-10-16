import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// A Radix-style "slot as a function" (Switch's `internal_do_not_use_render`): the Provider hands its state to a render
// prop the caller writes, and falls back to `children` when none is given.
const RCtx = createContext<{ checked: boolean; toggle: () => void }>({ checked: false, toggle: () => {} })

export function RProvider({ children, controlled, render }: { children?: React.ReactNode; controlled?: boolean; render?: (s: { checked: boolean; inForm: boolean }) => React.ReactNode }) {
  const [own, setOwn] = useState(false)
  // Radix's isFormControl: a boolean over a method of the element the trigger left in state (`!!el.closest('form')`)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const inForm = el ? !!el.closest('form') : true
  // Radix's useControllableState shape: a derived value over a prop and state (F269), handed on as a local object (F266)
  const checked = controlled !== undefined ? controlled : own
  const ctx = { checked, inForm }
  return <RCtx.Provider value={{ checked, toggle: () => { setOwn((c) => !c); setEl(document.body) } }}>{typeof render === 'function' ? render(ctx) : children}</RCtx.Provider>
}

export function RTrigger() {
  const c = useContext(RCtx)
  return (
    <button type="button" aria-pressed={c.checked} onClick={c.toggle}>
      toggle
    </button>
  )
}

export function RMirror() {
  const c = useContext(RCtx)
  return <input type="hidden" value={c.checked ? 'on' : 'off'} readOnly />
}
