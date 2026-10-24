import { Outlet } from '@brust/core/routes'
import Providers from './Providers'

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>child</title></head>
      <body>
        <Providers>
          <Outlet />
        </Providers>
      </body>
    </html>
  )
}
