// Fixture-local copy of the demo Layout (used by the React-path pages below).
// Self-contained so the test fixture survives example/hello-world being
// deleted or regenerated.
import type { ReactNode } from 'react'

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
      </body>
    </html>
  )
}
