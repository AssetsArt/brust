import type { ReactNode } from 'react'
export default function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title}</title></head>
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main>{children}</main>
        <footer>bench · bun-serve</footer>
      </body>
    </html>
  )
}
