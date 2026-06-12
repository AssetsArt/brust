// React route `/items/{id}` for the not-found fixture. Its loader calls
// `notFound()` when the item is missing — exercising the React `notFound()`
// trigger (thrown verdict → nearest catch-all rendered at HTTP 404), NOT this
// Component and NOT a 500/errorBoundary.
export default function Item({ data }: { data: { id: string } }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Item · not-found fixture</title>
      </head>
      <body>
        <main>
          <h1>ITEM PAGE {data.id}</h1>
        </main>
      </body>
    </html>
  )
}
