// The document root: native (a theme toggle), so every page ships the runtime and a client chunk.
import { Outlet } from '@brust/core/routes'
import { useState } from 'react'

export default function Layout() {
  const [dark, setDark] = useState(false)
  return (
    <html lang="en">
      <head>
        <title>static fixture</title>
        <link rel="stylesheet" href="/public/site.css" />
      </head>
      <body data-theme={dark ? 'dark' : 'light'}>
        <button id="theme" onClick={() => setDark(!dark)}>
          {dark ? 'dark' : 'light'}
        </button>
        <nav>
          <a href="/">home</a> <a href="/docs">docs</a> <a href="/docs/intro">intro</a> <a href="/poke/pikachu">pikachu</a>
        </nav>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
