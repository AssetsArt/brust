// Route "/type-chart" — NATIVE route. A static 18×18 type-effectiveness matrix:
// pure read-only data, the ideal native page (compiled to jinja, rendered in
// Rust, zero React on the server). The 19×19 grid is pre-flattened in the loader
// to a single row-major `cells` array so the template uses ONE `.map()` into a
// CSS grid (nested maps aren't proven on the native path — see GAPS S10).
import { BrustPage, Island } from '../../../runtime/index.ts'
import TeamBuilder from '../components/TeamBuilder'
import type { TypeChartData } from '../lib/types'

export default function TypeChart({ cells, teamInitial }: TypeChartData) {
  return (
    <BrustPage lang="en" className="dark" title="PokéDex · type chart">
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
            <a className="aa-nav-item" href="/">
              <span>All Pokémon</span>
            </a>
            <a className="aa-nav-item is-active" href="/type-chart">
              <span>Type chart</span>
              <span className="aa-nav-item__count">native</span>
            </a>
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
              <b>Type chart</b>
            </div>
          </header>

          <div className="aa-content">
            <div className="aa-page-header">
              <div>
                <h1 className="aa-page-header__title">Type chart</h1>
                <div className="aa-page-header__desc">
                  Damage relations · row attacks column · rendered ฝั่ง Rust จาก jinja (native:true ·
                  ไม่มี React runtime ใน payload)
                </div>
              </div>
            </div>

            <div className="dex-tc-legend">
              <span className="dex-tc-legend__item">
                <span className="dex-tc__cell dex-tc__cell--super dex-tc__swatch">2</span> super
                effective
              </span>
              <span className="dex-tc-legend__item">
                <span className="dex-tc__cell dex-tc__cell--weak dex-tc__swatch">½</span> not very
              </span>
              <span className="dex-tc-legend__item">
                <span className="dex-tc__cell dex-tc__cell--none dex-tc__swatch">0</span> no effect
              </span>
            </div>

            <div className="dex-tc-scroll">
              <div className="dex-tc">
                {cells.map((c) => (
                  <div key={c.id} className={c.className} title={c.title}>
                    {c.content}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>

        <Island component={TeamBuilder} props={teamInitial} ssr hydrate="load" />
      </div>
    </BrustPage>
  )
}
