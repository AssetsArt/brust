import * as React from 'react'
import { createContext, useContext } from 'react'
import { RB } from './Rend'

export const L = createContext<{ label: string }>({ label: 'default' })
export function LC() {
  const c = useContext(L)
  return <b>{c.label}</b>
}
// the render body holds a Provider of its own: it scopes ITS consumers only, never the wrapper's children
export function Wrapper({ children }: { children?: React.ReactNode }) {
  return (
    <div>
      <RB render={() => <L.Provider value={{ label: 'inner' }}>{null}</L.Provider>} />
      {children}
    </div>
  )
}
