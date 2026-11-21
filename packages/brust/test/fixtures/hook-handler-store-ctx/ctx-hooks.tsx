import type { ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'

/** The context, declared with its hooks (an imported hook may read only React hooks and globals). */
export const Ctx = createContext('dflt')

/** A Provider of Ctx written as a component in the context's own module. */
export function Frame({ value, children }: { value: string; children?: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// F580 cell 8: a function the hook returns, used as an event handler by name, that reads a context value.
/** 8a: the handler reads the context value directly. */
export function useCtxRead() {
  const [v, setV] = useState('none')
  const c = useContext(Ctx)
  const run = () => setV('c=' + c)
  return { v, run }
}

/** 8b: the handler reads it through a hook derived value. */
export function useCtxDerived() {
  const [v, setV] = useState('none')
  const c = useContext(Ctx)
  const label = 'c=' + c
  const run = () => setV(label)
  return { v, run }
}
