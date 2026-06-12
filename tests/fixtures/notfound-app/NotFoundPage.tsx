// Global catch-all (`path: '*'`) leaf for the not-found integration fixture.
// Rendered at HTTP 404 on any unmatched path (full document render path) AND
// as a SPA-nav payload (`/_brust/page/*`) carrying a real <main> body.
export default function NotFoundPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>404 · not-found fixture</title>
      </head>
      <body>
        <main>
          <h1>NOT FOUND PAGE</h1>
        </main>
      </body>
    </html>
  )
}
