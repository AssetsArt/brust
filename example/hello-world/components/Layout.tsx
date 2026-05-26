import type { ReactNode } from 'react'

/** Inline styles keep the demo self-contained — no extra build step,
 * no asset pipeline. Real apps would extract to a stylesheet. */
const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a; background: #fafaf7; line-height: 1.55;
  }
  header { background: #ffffff; border-bottom: 1px solid #e7e5df; }
  header .container {
    max-width: 760px; margin: 0 auto; padding: 14px 20px;
    display: flex; align-items: center; gap: 28px;
  }
  header .brand {
    font-weight: 700; font-size: 18px; color: #8a3324;
    text-decoration: none; letter-spacing: -0.01em;
  }
  header nav { display: flex; gap: 18px; flex-wrap: wrap; }
  header nav a {
    color: #555; text-decoration: none; font-size: 14px;
    padding: 4px 0; border-bottom: 2px solid transparent;
    transition: color 0.12s, border-color 0.12s;
  }
  header nav a:hover { color: #8a3324; border-bottom-color: #8a3324; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 16px; }
  main h1 { font-size: 28px; margin: 0 0 16px; letter-spacing: -0.01em; }
  main p { margin: 10px 0; color: #2a2a2a; }
  main a { color: #8a3324; }
  main code, main pre {
    background: #f0eee8; padding: 2px 6px; border-radius: 4px;
    font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 13px;
  }
  main pre { padding: 12px; overflow-x: auto; }
  footer {
    max-width: 760px; margin: 32px auto 24px; padding: 16px 20px;
    border-top: 1px solid #e7e5df; color: #888; font-size: 12px;
  }
  footer code { background: #f0eee8; padding: 2px 4px; border-radius: 3px; }
  [data-testid="bio-fallback"], [data-testid="spinner"] {
    color: #8a8a8a; font-style: italic;
  }
  [data-brust-island] { display: inline-block; margin: 12px 0; }
`

/** Nav items wired as plain `<a href>` — classic MPA navigation. Each
 * click triggers a full request and a fresh server render. (SPA-style
 * navigation interception is a future Brust feature.) */
const NAV = [
  { href: '/',                label: 'Home' },
  { href: '/blog/welcome',    label: 'Blog' },
  { href: '/slow-suspense',   label: 'Streaming' },
  { href: '/profile/world',   label: 'Profile' },
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
        <style>{STYLES}</style>
      </head>
      <body>
        <header>
          <div className="container">
            <a href="/" className="brand">brust</a>
            <nav>
              {NAV.map((item) => (
                <a key={item.href} href={item.href}>{item.label}</a>
              ))}
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer>
          Real-time endpoints aren't navigable but you can poke them:{' '}
          <code>curl -N http://127.0.0.1:3000/sse-counter</code>
          {' · '}
          <code>wscat -c ws://127.0.0.1:3000/ws/echo</code>
        </footer>
      </body>
    </html>
  )
}
