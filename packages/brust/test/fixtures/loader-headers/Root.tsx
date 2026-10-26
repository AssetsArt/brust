import { Outlet } from '@brust/core/routes'

export default function Root() {
  return (
    <html lang="en">
      <head />
      <body>
        <nav>
          <a href="/">home</a> <a href="/public">public</a> <a href="/private/one">private-one</a>{' '}
          <a href="/private/two">private-two</a> <a href="/logout">logout</a>
        </nav>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
