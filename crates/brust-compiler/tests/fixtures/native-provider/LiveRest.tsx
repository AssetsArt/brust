import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// switch-provider-chain link 3: Radix's SwitchTrigger shape. The trigger binds live context values on a forwarding
// component's element AHEAD of a spread of its own rest (`{...rest}`), then a composed `onClick` after it.
const L = createContext<{ on: boolean; flip: () => void; label: string }>({ on: false, flip: () => {}, label: '' })

function getState(on: boolean) {
  return on ? 'checked' : 'unchecked'
}
function compose<E>(a: ((e: E) => void) | undefined, b: (e: E) => void) {
  return (e: E) => {
    a?.(e)
    b(e)
  }
}

const PBtn = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>((props, ref) => (
  <button {...props} ref={ref} />
))

function LProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <L.Provider value={{ on, flip: () => setOn((o) => !o), label: 'l' }}>{children}</L.Provider>
}
function LTrigger({ onClick, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(L)
  return (
    <PBtn
      type="button"
      role="switch"
      aria-checked={c.on}
      data-state={getState(c.on)}
      {...rest}
      onClick={compose(onClick, () => c.flip())}
    />
  )
}
export function LRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <LProvider>
      <LTrigger {...rest} />
    </LProvider>
  )
}
// The Thumb: a consumer the call site passes as children, which travel in the root's rest into the trigger (F298).
export function LThumb() {
  const c = useContext(L)
  return <span data-state={getState(c.on)} />
}
// Radix's SwitchBubbleInput: a context value that does not change (`label`) handed to a forwarding child under a key of
// the author's own, ahead of a composed handler: frozen at the call site (the Provider's value is constant), never a link.
export function LBubble({ onClick, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(L)
  return <PBtn name={c.label} {...rest} onClick={compose(onClick, () => c.flip())} />
}
export function LBubbleRoot() {
  return (
    <LProvider>
      <LBubble />
    </LProvider>
  )
}
