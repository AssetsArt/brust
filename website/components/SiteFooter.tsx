// The canon footer: wordmark and licence, then Docs / Project / Packages link columns.
// Styled with Tailwind utilities (L31).
function FooterLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="block py-[.12rem] text-ink-2 no-underline hover:text-ink" href={href}>
      {children}
    </a>
  )
}

const HEAD = 'mb-2 mt-0 text-[14px] text-ink'

export default function SiteFooter() {
  return (
    <div className="mx-auto max-w-[1160px] px-4">
      <footer className="grid grid-cols-[1.5fr_1fr_1fr_1fr] gap-8 py-10 text-[14px] text-ink-2 max-wide:grid-cols-2">
        <div>
          <a className="inline-flex items-center gap-[.6rem] font-display text-[18px] font-semibold uppercase tracking-[.14em] text-ink no-underline" href="/">
            brust
          </a>
          <p className="mt-2">React components compiled ahead of time, served by Rust. MIT License.</p>
        </div>
        <div>
          <h4 className={HEAD}>Docs</h4>
          <FooterLink href="/docs/quickstart">Quickstart</FooterLink>
          <FooterLink href="/docs/routing">Routing</FooterLink>
          <FooterLink href="/docs/rendering-tiers">Rendering tiers</FooterLink>
          <FooterLink href="/docs/cookbook/hello-world">Cookbook</FooterLink>
        </div>
        <div>
          <h4 className={HEAD}>Project</h4>
          <FooterLink href="https://github.com/AssetsArt/brust">GitHub</FooterLink>
          <FooterLink href="https://github.com/AssetsArt/brust/releases">Releases</FooterLink>
          <FooterLink href="https://github.com/AssetsArt/brust/commits/v2">Changelog</FooterLink>
        </div>
        <div>
          <h4 className={HEAD}>Packages</h4>
          <FooterLink href="https://www.npmjs.com/package/@brust/core">@brust/core on npm</FooterLink>
          <FooterLink href="https://www.npmjs.com/package/@brust/create-app">@brust/create-app</FooterLink>
        </div>
      </footer>
    </div>
  )
}
