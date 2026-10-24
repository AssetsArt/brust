import { createContext } from 'react'

export const Ctx = createContext('dflt')

export default function Providers({ children }: { children?: any }) {
  return <Ctx.Provider value="child">{children}</Ctx.Provider>
}
