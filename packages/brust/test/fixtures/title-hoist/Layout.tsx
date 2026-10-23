import { Outlet } from '@brust/core/routes'

// The shared document: its own <title> and charset in the head, like Assets Art's layout.
export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Site</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
