import { Outlet } from '@brust/core/routes'

export default function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>rc client islands</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
