import { Outlet } from '@brust/core/routes'

export default function Root() {
  return (
    <html lang="en">
      <head />
      <body>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
