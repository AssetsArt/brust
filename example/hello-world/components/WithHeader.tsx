import type { RouteContext } from '../../../runtime/routes.ts'

export default function WithHeader({ req }: RouteContext) {
  const sp = req.search['name'] ?? 'world'
  return (
    <html>
      <body>
        <h1>Hello, {sp}</h1>
        <p>see x-render-ms response header</p>
      </body>
    </html>
  )
}
