// Document root (contract 6) + useState ⇒ native tier ⇒ runtime + chunk tags on every page.
import { Outlet } from '@brust/brust/routes'
import { useState } from 'react'

export default function AppLayout() {
  const [dark, setDark] = useState(false)
  return (
    <html lang="en">
      <head>
        <title>fixture</title>
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body data-theme={dark ? 'dark' : 'light'}>
        <button onClick={() => setDark(!dark)}>theme</button>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
