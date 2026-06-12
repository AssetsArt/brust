// NotFound — native global 404 catch-all (route `{ path: '*' }` in routes.tsx).
//
// Dogfoods the framework 404 feature: the live server renders this at HTTP 404
// for any unmatched path (native + SPA), and the SSG export crawls this global
// catch-all to write `dist/static/404.html` — which Cloudflare Pages serves
// (with HTTP 404) for any path that doesn't match a prerendered file. This
// REPLACES the old hand-written `public/404.html`; the framework now owns it.
//
// Static content only (no behavior): a static page is trivially native — member
// paths + literal JSX, no conditionals or local bindings, so the native
// route-root single-return rule holds. Reuses the brand look from app.css
// tokens (the `--brand` green via `text-link`, `bg-accent`/`text-accent-fg`
// buttons, `border-line`, `text-fg-muted`) so it theme-flips like the rest of
// the site — no standalone <style> block needed (app.css is auto-injected).
//
// head: pre-paint FOUC killer (stamps data-theme from localStorage before first
// paint) + `noindex` robots — mirrors Home's shell. BrustPage head text must be
// a literal, so the script is duplicated rather than imported.
import { BrustPage } from 'brustjs'

export default function NotFound() {
  return (
    <BrustPage
      title="404 — Page not found · Brust"
      description="The page you’re looking for doesn’t exist or has moved."
      head={[
        {
          tag: 'script',
          text: "(()=>{try{const t=localStorage.getItem('brust-docs-theme');if(t)document.documentElement.dataset.theme=t}catch{}})()",
        },
        { tag: 'meta', name: 'robots', content: 'noindex' },
        { tag: 'link', rel: 'icon', href: '/favicon.ico' },
        { tag: 'link', rel: 'icon', type: 'image/png', href: '/favicon.png' },
      ]}
    >
      <main className="grid min-h-screen place-items-center px-6 py-16">
        <div className="w-full max-w-lg text-center">
          <p className="font-mono text-[clamp(4rem,2rem+12vw,8rem)] font-semibold leading-none tracking-tight text-link">
            404
          </p>
          <h1 className="mt-5 text-2xl font-semibold">Page not found</h1>
          <p className="mx-auto mt-2 max-w-md text-fg-muted">
            The page you’re looking for doesn’t exist or has moved. Check the URL, or head back to
            the documentation.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/"
              className="inline-flex h-11 items-center rounded-[var(--radius-control)] bg-accent px-6 font-semibold text-accent-fg no-underline transition-opacity duration-150 hover:opacity-90"
            >
              Home
            </a>
            <a
              href="/docs"
              className="inline-flex h-11 items-center rounded-[var(--radius-control)] border border-line px-6 font-medium text-fg no-underline transition-colors duration-150 hover:border-brand-300/60 hover:text-link"
            >
              Documentation
            </a>
          </div>
        </div>
      </main>
    </BrustPage>
  )
}
