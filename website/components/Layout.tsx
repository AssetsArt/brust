// The document root for every docs page: <html>, the site header, and <Outlet/> for the page.
import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>brust docs</title>
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body>
        <header className="site-header">
          <a href="/" className="brand">brust</a>
          <nav aria-label="Site">
            <a href="/docs">Docs</a>
            <a href="https://github.com/AssetsArt/brust">GitHub</a>
          </nav>
        </header>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
