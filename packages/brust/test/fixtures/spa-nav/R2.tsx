import { Outlet } from '@brust/core/routes'
import Count from './Count'
import Nav from './Nav'

export default function R2() {
  return (
    <html lang="th" className="r2">
      <head>
        <link rel="stylesheet" href="/public/site.css" />
        <script src="/public/theme.js" />
      </head>
      <body className="r2">
        <header data-layout="R2">
          <Count name="R2" />
          <Nav />
        </header>
        <div data-brust-persist="player" id="player" />
        <Outlet />
      </body>
    </html>
  )
}
