// The document root: a plain <html> with <Outlet/> for the page. Static files are served from /public.
import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>brust app</title>
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
