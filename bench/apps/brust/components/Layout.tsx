// The document (S9): plain <html>, <Outlet/> for the leaf. `title` comes from the merged loader context.
import { Outlet } from '@brust/core/routes'
export default function Layout(props: { title: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
      </head>
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main><Outlet /></main>
        <footer>bench · brust v2</footer>
      </body>
    </html>
  )
}
