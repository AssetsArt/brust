import { Outlet } from '@brust/core/routes'
import { createContext } from 'react'

const Ctx = createContext('dflt')
export { Ctx as Theme }

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>alias</title></head>
      <body>
        <Ctx.Provider value="layout">
          <Outlet />
        </Ctx.Provider>
      </body>
    </html>
  )
}
