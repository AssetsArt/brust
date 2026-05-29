import type { ReactNode } from 'react'

// Shared bench layout — kept byte-identical to the example's Layout so the
// React-SSR `/` probe renders the exact same component on every scenario AND
// stays comparable to historical bench numbers. The nav links point at demo
// routes the bench app doesn't serve; the bench only GETs `/`, never follows
// them, so they're inert here.
const NAV = [
  { href: '/', label: 'Home' },
  { href: '/blog/welcome', label: 'Blog' },
  { href: '/slow-suspense', label: 'Streaming' },
  { href: '/profile/world', label: 'Profile' },
]

interface LayoutProps {
  title: string
  children: ReactNode
}

export default function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Brust demo`}</title>
      </head>
      <body>
        <header className="bg-white border-b border-line">
          <div className="max-w-3xl mx-auto px-5 py-3.5 flex items-center gap-7">
            <a href="/" className="font-bold text-lg text-brand no-underline tracking-tight">
              brust
            </a>
            <nav className="flex gap-4 flex-wrap">
              {NAV.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="text-gray-600 text-sm py-1 border-b-2 border-transparent hover:text-brand hover:border-brand transition-colors"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-5 pt-8 pb-4 [&_h1]:text-3xl [&_h1]:mb-4 [&_h1]:tracking-tight [&_p]:my-2.5 [&_a]:text-brand">
          {children}
        </main>
        <footer className="max-w-3xl mx-auto px-5 py-4 mt-8 mb-6 border-t border-line text-gray-500 text-xs">
          Real-time endpoints aren't navigable but you can poke them:{' '}
          <code>curl -N http://127.0.0.1:3000/sse-counter</code>
          {' · '}
          <code>wscat -c ws://127.0.0.1:3000/ws/echo</code>
        </footer>
      </body>
    </html>
  )
}
