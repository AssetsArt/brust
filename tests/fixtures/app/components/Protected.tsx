import type { RouteContext } from '../../../../runtime/routes.ts'

export default function Protected({ req }: RouteContext) {
  const user = req.cookies['user'] ?? 'unknown'
  return (
    <html>
      <body>
        <h1>Protected</h1>
        <p>signed in as {user}</p>
      </body>
    </html>
  )
}
