import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>csp gaps</title>
      </head>
      <body>
        <nav>
          <a id="to-home" href="/shop">home</a>
          <a id="to-slow" href="/shop/slow">slow</a>
          <a id="to-forms" href="/shop/forms">forms</a>
        </nav>
        <Outlet />
      </body>
    </html>
  )
}
