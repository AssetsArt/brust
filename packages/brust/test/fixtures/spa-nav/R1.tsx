import { Outlet } from '@brust/core/routes'
import Count from './Count'
import Nav from './Nav'

export default function R1() {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/public/site.css" />
        <script src="/public/theme.js" />
      </head>
      <body>
        <header data-layout="R1">
          <Count name="R1" />
          <Nav />
        </header>
        <div data-brust-persist="player" id="player" />
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
