// React route `/items/{id}` whose loader `throw notFound()` for any id, in an
// app that registers NO catch-all (`path: '*'`). The render dispatch must then
// serve the framework DEFAULT 404 body at HTTP 404 — never a 500, never a crash.
export default function Item({ data }: { data: { id: string } }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Item</title>
      </head>
      <body>
        <main>
          <h1>ITEM {data.id}</h1>
        </main>
      </body>
    </html>
  )
}
