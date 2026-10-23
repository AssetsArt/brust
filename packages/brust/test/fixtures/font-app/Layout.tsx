// F411: the layout preloads the font its stylesheet brings in, by importing it.
import { Outlet } from '@brust/core/routes'
import face from './fonts/face.woff2'
import './face.css'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>font fixture</title>
        <link rel="preload" as="font" type="font/woff2" crossOrigin="" href={face} />
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
