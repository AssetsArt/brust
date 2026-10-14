import { createContext } from 'react'

export const Ctx = createContext<{ ok: string }>({ ok: 'shared-default' })
