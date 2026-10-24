import { Outlet } from '@brust/core/routes'
import { Ctx } from './ctx'

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>shared</title></head>
      <body>
        <Ctx.Provider value="layout">
          <Outlet />
        </Ctx.Provider>
      </body>
    </html>
  )
}
