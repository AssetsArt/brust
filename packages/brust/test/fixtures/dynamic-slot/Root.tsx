import { Outlet } from '@brust/core/routes'

export default function Root() {
  return (
    <html lang="en">
      <head>
        <title>dynamic slot</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  )
}
