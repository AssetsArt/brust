import { Outlet } from '@brust/core/routes'
import { createContext } from 'react'

export const Ctx = createContext('dflt')

export default function Outer() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>nested</title></head>
      <body>
        <Ctx.Provider value="outer">
          <Outlet />
        </Ctx.Provider>
      </body>
    </html>
  )
}
