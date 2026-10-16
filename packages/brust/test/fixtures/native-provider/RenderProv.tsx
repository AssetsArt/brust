import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// A Radix-style "slot as a function" (Switch's `internal_do_not_use_render`): the Provider hands its state to a render
// prop the caller writes, and falls back to `children` when none is given.
const RCtx = createContext<{ checked: boolean; toggle: () => void }>({ checked: false, toggle: () => {} })

export function RProvider({ children, render }: { children?: React.ReactNode; render?: (s: { checked: boolean }) => React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  return <RCtx.Provider value={{ checked, toggle: () => setChecked((c) => !c) }}>{typeof render === 'function' ? render({ checked }) : children}</RCtx.Provider>
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
