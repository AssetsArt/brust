import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <title>csp</title>
      </head>
      <body>
        <nav>
          <a id="to-home" href="/shop">home</a>
          <a id="to-slow" href="/shop/slow">slow</a>
          <a id="to-styled" href="/shop/styled">styled</a>
        </nav>
        <Outlet />
      </body>
    </html>
  )
}
