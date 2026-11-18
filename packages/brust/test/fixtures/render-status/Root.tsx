import { Outlet } from '@brust/core/routes'

/** The layout shows its own loader's data: a rendered status page keeps it. */
export default function Root(props: { user: string }) {
  return (
    <html lang="en">
      <head />
      <body>
        <nav>
          <a href="/">home</a> <a href="/forbidden">forbidden</a> <a href="/down">down</a> <a href="/gone">gone</a>{' '}
          <a href="/react-forbidden">react-forbidden</a>
        </nav>
        <p data-user>{props.user}</p>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}
