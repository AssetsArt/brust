import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>none</title></head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
