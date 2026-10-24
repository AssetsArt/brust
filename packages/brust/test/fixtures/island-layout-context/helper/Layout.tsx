import { Outlet } from '@brust/core/routes'
import { Provider } from './theme'

export default function Layout() {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><title>helper</title></head>
      <body>
        <Provider>
          <Outlet />
        </Provider>
      </body>
    </html>
  )
}
