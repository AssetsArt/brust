import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>csp static</title>
      </head>
      <body>
        <nav>
          <a id="to-home" href="/site">home</a>
          <a id="to-about" href="/site/about">about</a>
        </nav>
        <Outlet />
      </body>
    </html>
  )
}
