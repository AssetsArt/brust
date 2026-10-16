import { createContext, useContext, useState } from 'react'
// Radix Switch's shape (F298): Root spreads its rest (children included) into a trigger under its own Provider; the
// trigger reads the context (a host of its own), and the Thumb the page passes reads it too.
const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
function state(on: boolean) {
  return on ? 'checked' : 'unchecked'
}
function KProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider>
}
function KTrigger({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(K)
  return (
    <button type="button" {...rest} data-testid="box" data-state={state(c.on)} onClick={c.flip}>
      {children}
    </button>
  )
}
export function KThumb() {
  const c = useContext(K)
  return <span data-state={state(c.on)} />
}
export function KRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <KProvider>
      <KTrigger {...rest} />
    </KProvider>
  )
}
