import { Outlet } from '@brust/core/routes'

// The shared document: a root layout with its own charset and title, and links every test navigates by.
export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Site</title>
      </head>
      <body>
        <nav>
          <a href="/">home</a> <a href="/react">react</a> <a href="/own">own</a> <a href="/missing">missing</a>
        </nav>
        <Outlet />
      </body>
    </html>
  )
}
