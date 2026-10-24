import { Outlet } from '@brust/core/routes'
import { createContext, useState } from 'react'

export const Ctx = createContext('dflt')

export default function Layout() {
  const [v] = useState('layout')
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>state</title></head>
      <body>
        <Ctx.Provider value={v}>
          <Outlet />
        </Ctx.Provider>
      </body>
    </html>
  )
}
