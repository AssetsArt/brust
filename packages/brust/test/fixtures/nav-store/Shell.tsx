import { Outlet } from '@brust/core/routes'
import NavIsland from './NavIsland'
import NavNative from './NavNative'

export default function Shell() {
  return (
    <html lang="en">
      <head>
        <title>nav-store</title>
      </head>
      <body>
        <header data-layout="shell">
          <nav>
            <a href="/">home</a> <a href="/other">other</a> <a href="/slow">slow</a> <a href="/island">island</a>{' '}
            <a href="/missing">missing</a>
          </nav>
          <NavNative />
          <NavIsland id="layout" />
        </header>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
