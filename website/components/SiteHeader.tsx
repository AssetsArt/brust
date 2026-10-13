// The site header: BRUST wordmark with the @brust/core version, and the site nav (no search until search exists).
// Styled with Tailwind utilities (L31): the nav links share one component, the wordmark's class string is the
// same one the footer uses (kept in step by hand: two places).
function NavLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="text-ink-2 no-underline hover:text-ink" href={href}>
      {children}
    </a>
  )
}

export default function SiteHeader({ version }: { version: string }) {
  return (
    <div className="mx-auto max-w-[1160px] px-4">
      <header className="flex items-center gap-6 py-4 max-narrow:flex-wrap max-narrow:gap-y-[.35rem]">
        <a className="flex items-center gap-[.6rem] font-display text-[19px] font-semibold uppercase tracking-[.14em] text-ink no-underline" href="/">
          brust <span className="whitespace-nowrap rounded-[4px] border border-rule px-[.4rem] font-mono text-[12px] font-normal normal-case tracking-[.02em] text-ink-2">{version}</span>
        </a>
        <nav className="ml-auto flex items-center gap-5 text-[15px] max-narrow:gap-4" aria-label="Site">
          <NavLink href="/docs">Docs</NavLink>
          <NavLink href="/docs/cookbook/hello-world">Cookbook</NavLink>
          <NavLink href="https://github.com/AssetsArt/brust">GitHub</NavLink>
        </nav>
      </header>
    </div>
  )
}
