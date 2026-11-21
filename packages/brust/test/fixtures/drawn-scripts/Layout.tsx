import { Outlet } from '@brust/core/routes'
import Lw from './Lw'

// Case 9: a layout that draws a host, around a page that may draw none.
export default function Layout() {
  return (
    <html>
      <head>
        <title>layout</title>
      </head>
      <body>
        <header>
          <Lw />
        </header>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
