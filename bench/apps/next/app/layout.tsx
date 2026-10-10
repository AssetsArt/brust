import type { ReactNode } from 'react'
export const metadata = { title: 'bench · next' }
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main>{children}</main>
        <footer>bench · next</footer>
      </body>
    </html>
  )
}
