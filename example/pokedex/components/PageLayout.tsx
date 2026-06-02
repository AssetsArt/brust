// Shared native layout shell. INLINED into each route at build time (T6): the
// route's root is <PageLayout native …>, whose expansion roots in <BrustPage>,
// which the compiler now promotes to the document shell. Pages supply only
// title/active/crumb + their aa-content inner.
//
// MUST stay single-return with no local bindings above it — a local `const`
// would make the compiler soft-fall-back to an SSR component (no <html> shell).
// active-nav uses conditional ELEMENTS (S11), not a className ternary
// (unsupported). See ../FRAMEWORK-GAPS.md.
import { BrustPage, Island } from '../../../runtime/index.ts'
import TeamBuilder from './TeamBuilder'

export default function PageLayout({
  title,
  active,
  crumb,
  teamProps,
  children,
}: {
  title: string
  active: 'list' | 'typechart'
  crumb: string
  teamProps: unknown
  children: unknown
}) {
  return (
    <BrustPage lang="en" className="dark" title={title}>
      <div className="aa-app">
        <aside className="aa-sidebar">
          <div className="aa-sidebar__brand">
            <div className="aa-sidebar__brand-mark">P</div>
            <div className="grow truncate">
              <div className="aa-sidebar__brand-name">PokéDex</div>
              <div className="aa-sidebar__brand-sub">brust example app</div>
            </div>
            <span className="aa-sidebar__env">native</span>
          </div>
          <nav className="aa-sidebar__nav">
            <div className="aa-sidebar__group-title">Pokédex</div>
            {active === 'list' ? (
              <a className="aa-nav-item is-active" href="/">
                <span>All Pokémon</span>
              </a>
            ) : (
              <a className="aa-nav-item" href="/">
                <span>All Pokémon</span>
              </a>
            )}
            {active === 'typechart' ? (
              <a className="aa-nav-item is-active" href="/type-chart">
                <span>Type chart</span>
                <span className="aa-nav-item__count">native</span>
              </a>
            ) : (
              <a className="aa-nav-item" href="/type-chart">
                <span>Type chart</span>
                <span className="aa-nav-item__count">native</span>
              </a>
            )}
          </nav>
          <div className="aa-sidebar__user">
            <span className="aa-avatar aa-avatar--sm dex-brand-avatar">B</span>
            <div className="grow truncate dex-user">
              <div className="dex-user__name">brust dev</div>
              <div className="dex-user__host">localhost</div>
            </div>
          </div>
        </aside>

        <main className="aa-main">
          <header className="aa-topbar">
            <div className="aa-topbar__crumb">
              <a href="/" className="dex-crumb__root">
                PokéDex
              </a>
              <span className="dex-crumb__sep">›</span>
              <b>{crumb}</b>
            </div>
          </header>

          <div className="aa-content">{children}</div>
        </main>

        <Island component={TeamBuilder} props={teamProps} ssr hydrate="load" />
      </div>
    </BrustPage>
  )
}
