import type { RouteContext } from '../../../../runtime/routes.ts'

interface LocalsDemoData {
  user: string
  paramCount: number
}

/** R6 — renders the loader data that itself came from `req.locals` written by
 * the `attachUser` middleware (see routes.tsx). Proves middleware → loader →
 * render locals flow over ONE req object. */
export default function LocalsDemo({ data }: RouteContext<Record<string, string>, LocalsDemoData>) {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>LocalsDemo</h1>
          <p>{`locals-user:${data.user}`}</p>
          <p>{`locals-params:${data.paramCount}`}</p>
        </main>
      </body>
    </html>
  )
}
