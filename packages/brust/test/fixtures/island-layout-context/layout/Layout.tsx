import { Outlet } from '@brust/core/routes'
import { createContext } from 'react'

export const Ctx = createContext('dflt')

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>layout provider</title></head>
      <body>
        <Ctx.Provider value="layout">
          <Outlet />
        </Ctx.Provider>
      </body>
    </html>
  )
}
