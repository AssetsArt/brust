import { createContext, useContext, useState } from 'react'
// Radix Switch's shape (F298): Root spreads its rest (children included) into a trigger under its own Provider, and the
// Thumb the caller passes reads that Provider.
const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
function state(on: boolean) {
  return on ? 'checked' : 'unchecked'
}
function KProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider>
}
function KLabel({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(K)
  return (
    <button type="button" {...rest} data-testid="box" onClick={c.flip}>
      {children}
    </button>
  )
}
export function KThumb({ className }: { className?: string }) {
  const c = useContext(K)
  return <span className={className} data-state={state(c.on)} />
}
export function KRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <KProvider>
      <KLabel {...rest} />
    </KProvider>
  )
}
