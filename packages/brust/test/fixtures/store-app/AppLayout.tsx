// Static document root: pages that are static themselves carry no runtime script.
import { Outlet } from '@brust/core/routes'

export default function AppLayout() {
  return (
    <html lang="en">
      <head>
        <title>store fixture</title>
      </head>
      <body>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
