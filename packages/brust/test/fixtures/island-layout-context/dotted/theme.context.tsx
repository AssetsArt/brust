import { createContext, useContext } from 'react'

const Ctx = createContext('dflt')

export function useTheme() {
  return useContext(Ctx)
}

export const label = 'theme'

export function Provider({ children }: { children?: any }) {
  return <Ctx.Provider value="layout">{children}</Ctx.Provider>
}
