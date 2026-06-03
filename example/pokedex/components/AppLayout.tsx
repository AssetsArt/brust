// Router-level native layout (Approach a: nested routes + <Outlet/>). Written
// ONCE and nested as the parent of every page route in routes.tsx. The synth
// wrapper the compiler builds is `<AppLayout native><Leaf native/></AppLayout>`
// — AppLayout receives NO props at the call site, so the chrome data it renders
// (title / active / crumb / teamProps) comes from the MERGED LOADER CONTEXT
// instead (F5 chrome-prop migration). Each leaf loader returns those fields and
// the chain-loader merge folds them into one flat jinja context; the names
// below are destructured so the native compiler resolves them as member-paths
// ({{ title }}, active === 'list', <TeamBuilder props={teamProps}/>).
//
// MUST stay single-return with no local bindings above it — a local `const`
// would make the compiler soft-fall-back to an SSR component (no <html> shell).
// Active-nav is now CLIENT-driven: each <NavLink> is a native directive component
// whose behavior watches brustjs/navigation's `nav.path` and sets is-active itself
// (no SSR `active` conditional, no data-brust-active-nav magic). AppLayout owns the
// single <main> (leaves are fragments in the <Outlet/> slot) — a leaf adding its
// own <main> breaks SPA-nav extraction. See ../FRAMEWORK-GAPS.md.
import { BrustPage, Island, Outlet } from 'brustjs'
import type { TeamMember } from '../lib/types'
import NavLink from './NavLink'
import NavPreloader from './NavPreloader'
import TeamBuilder from './TeamBuilder'
import ThemeToggle from './ThemeToggle'

export default function AppLayout({
  title,
  crumb,
  teamProps,
  mode,
}: {
  title: string
  crumb: string
  teamProps: { teamInitial: TeamMember[] }
  mode: 'dark' | 'light'
}) {
  return (
    <BrustPage
      lang="en"
      data-mode={mode}
      title={title}
      head={[{ tag: 'link', rel: 'icon', href: '/favicon.svg' }]}
    >
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
            <NavLink native href="/" label="All Pokémon" />
            <NavLink native href="/type-chart" label="Type chart" count="native" />
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
            <ThemeToggle native />
          </header>

          <div className="aa-content">
            <Outlet />
          </div>
        </main>

        <Island component={TeamBuilder} props={teamProps} ssr hydrate="load" />
        <Island component={NavPreloader} hydrate="load" />
      </div>
    </BrustPage>
  )
}
