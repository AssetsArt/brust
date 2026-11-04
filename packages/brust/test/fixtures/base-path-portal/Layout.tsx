import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <title>portal</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
