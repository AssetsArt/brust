import { createContext } from 'react'

export const Ctx = createContext<{ label: string }>({ label: 'default' })
