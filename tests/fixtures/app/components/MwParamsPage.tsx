import type { RouteContext } from '../../../../runtime/routes.ts'

/** R6 — trivial page behind the `blockParam` middleware (see routes.tsx),
 * which reads `req.params.id` and short-circuits 412 on 'blocked'. */
export default function MwParamsPage({ params }: RouteContext<{ id: string }>) {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>MwParams</h1>
          <p>{`id:${params.id}`}</p>
        </main>
      </body>
    </html>
  )
}
