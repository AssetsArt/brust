// Docs chrome — NATIVE layout (mdRoutes `layout:`). Owns the document shell
// (BrustPage) and the SINGLE <main>; md leaves render into <Outlet/>.
//
// MUST stay single-return with NO local bindings (a `const` above the return
// soft-falls the compiler back to an SSR component — no <html> shell).
// Everything dynamic is a member path into the MERGED loader context:
//   __md.{title,description} — from the md leaf's generated loader (head)
//   nav / pager             — from the layout loader (lib/nav.ts, task 1.3)
//
// aria-current uses a CONDITIONAL ATTRIBUTE — `aria-current={item.active ?
// 'page' : undefined}` — the `undefined` branch omits the attribute on
// inactive links (no `aria-current=""`). The pager tests the optional member
// directly (`{pager.prev && <a href={pager.prev.path}>}`). Both compile on
// native routes now (no per-item-ternary or sentinel workaround needed).
import { BrustPage, Island, Outlet } from 'brustjs'
import type { DocsChrome } from '../lib/nav.ts'
import NavPreloader from './NavPreloader'
import SearchPalette from './SearchPalette'
import ThemeToggle from './ThemeToggle'

export default function DocsLayout({
  __md,
  nav,
  pager,
}: {
  __md: { title?: string; description?: string }
} & DocsChrome) {
  return (
    <BrustPage
      title={__md.title}
      description={__md.description}
      data-brust-view-transitions=""
      // pre-paint FOUC killer: stamp data-theme from localStorage before first
      // paint. Static-literal text (compiler requirement) — the same one-liner
      // lives in Home's shell; keep both in sync.
      head={[
        {
          tag: 'script',
          text: "(()=>{try{const t=localStorage.getItem('brust-docs-theme');if(t)document.documentElement.dataset.theme=t}catch{}})()",
        },
        { tag: 'link', rel: 'icon', href: '/favicon.ico' },
        { tag: 'link', rel: 'icon', type: 'image/png', href: '/favicon.png' },
      ]}
    >
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:block focus:bg-accent focus:px-5 focus:py-3 focus:text-sm focus:font-medium focus:text-accent-fg"
      >
        Skip to content
      </a>

      {/* SPA-nav progress bar — outside <main> so the navigator never tears it
          down mid-navigation; renders null while idle. */}
      <Island component={NavPreloader} hydrate="load" />

      {/* solid (opaque) header — z from the DESIGN.md scale (--z-nav: 10) */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
          <a href="/" className="text-base font-bold tracking-tight text-fg no-underline">
            brust
          </a>
          <nav aria-label="Site" className="flex items-center gap-4 text-sm">
            <a href="/docs" className="text-fg-muted transition-colors hover:text-fg">
              Overview
            </a>
            <a
              href="https://github.com/AssetsArt/brust"
              className="text-fg-muted transition-colors hover:text-fg"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle native />
            {/* The site's ONLY React island. No `ssr` prop → host is empty
                until idle hydration; .search-slot (app.css) reserves the
                button's box so the header never shifts. */}
            <span className="search-slot">
              <Island component={SearchPalette} hydrate="idle" />
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-10 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        {/* mobile: simple stacked top list; desktop: sticky fixed-width rail.
            data-brust-active-nav: the runtime reconciler (active-nav.ts) moves
            aria-current="page" here on every SPA navigation — the sidebar sits
            OUTSIDE <main>, so without it the active item goes stale after a
            client-side nav. Active VISUALS are keyed on [aria-current] in
            app.css (not baked utility classes) for the same reason. */}
        <nav
          aria-label="Docs"
          data-brust-active-nav
          className="text-sm md:sticky md:top-24 md:max-h-[calc(100vh-7rem)] md:self-start md:overflow-y-auto"
        >
          {nav.map((group) => (
            <section key={group.group} className="mb-6">
              {group.group && (
                <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  {group.group}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.path}>
                    {/* Single anchor with a CONDITIONAL attribute — the `undefined`
                        branch omits aria-current entirely on inactive links. */}
                    <a
                      href={item.path}
                      aria-current={item.active ? 'page' : undefined}
                      className="block rounded-[var(--radius-control)] px-2.5 py-1.5 text-fg-muted no-underline transition-colors hover:text-fg"
                    >
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="min-w-0">
          {/* The pager footer lives INSIDE <main>: SPA navigation swaps the
              inner-<main> payload only, so anything per-page (article + pager)
              must be in here or it goes stale after a client-side nav. */}
          <main id="content">
            <Outlet />

            {/* Cond TEST on the optional member itself, with deeper reads in the
                body — no precomputed boolean siblings needed. */}
            <footer className="mt-12 flex max-w-[72ch] items-stretch justify-between gap-4 border-t border-line pt-6">
              {pager.prev && (
                <a
                  href={pager.prev.path}
                  rel="prev"
                  className="group flex flex-col gap-1 rounded-[var(--radius-card)] border border-line px-4 py-3 no-underline transition-colors hover:border-fg-muted"
                >
                  <span className="text-sm text-fg-muted">Previous</span>
                  <span className="font-medium text-link">{pager.prev.title}</span>
                </a>
              )}
              {pager.next && (
                <a
                  href={pager.next.path}
                  rel="next"
                  className="group ml-auto flex flex-col items-end gap-1 rounded-[var(--radius-card)] border border-line px-4 py-3 text-right no-underline transition-colors hover:border-fg-muted"
                >
                  <span className="text-sm text-fg-muted">Next</span>
                  <span className="font-medium text-link">{pager.next.title}</span>
                </a>
              )}
            </footer>
          </main>
        </div>
      </div>
    </BrustPage>
  )
}
