// The document root (static): links the author's own stylesheet; brust's links go before it.
import { Outlet } from '@brust/core/routes'
import './layout.css'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>css fixture</title>
        <link rel="stylesheet" href="/public/user.css" />
      </head>
      <body>
        <header>top</header>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
