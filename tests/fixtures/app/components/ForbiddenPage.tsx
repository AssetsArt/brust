/** R7 — the route's loader always throws `httpError(403)`, so this component
 * must NEVER render. The integration test asserts its text is absent. */
export default function ForbiddenPage() {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>ForbiddenPage rendered — httpError did not short-circuit</h1>
        </main>
      </body>
    </html>
  )
}
