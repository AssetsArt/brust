// The document root imports the Tailwind entry once: every route links it (L19).
import { Outlet } from '@brust/core/routes'
import './app.css'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>tailwind fixture</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
