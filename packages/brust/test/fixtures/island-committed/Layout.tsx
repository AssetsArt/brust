import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>island committed</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
