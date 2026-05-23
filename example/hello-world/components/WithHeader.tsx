import type { RouteContext } from '../../../runtime/routes.ts'

export default function WithHeader({ req }: RouteContext) {
  const name = req.search['name'] ?? 'world'
  return (
    <html>
      <body>
        <h1>Hello, {name}</h1>
        <p>see x-render-ms response header</p>
      </body>
    </html>
  )
}
