// Route "/pokemon/{name}" — NATIVE detail page. Per the decision to push native
// as far as possible, the evolution chain is loaded BLOCKING in the loader (a
// native/jinja route has no React tree, so <Suspense> streaming is impossible —
// see ../FRAMEWORK-GAPS.md §3).
//
// Native routes can't use conditionals (§11), so there is no `{notFound ? … : …}`
// branch: BOTH the detail body and the 404 block are always emitted and one is
// hidden via a loader-computed `dex-hide` class (contentClass / notFoundClass).
// Same trick for the abilities row, the evolution section, and each evolution
// arrow/level separator.
import { BrustPage, Island } from '../../../runtime/index.ts'
import AddToTeamButton from '../components/AddToTeamButton'
import TeamBuilder from '../components/TeamBuilder'
import type { DetailData } from '../lib/types'

export default function DetailPage({
  contentClass,
  notFoundClass,
  abilitiesClass,
  evoSectionClass,
  displayName,
  num,
  artwork,
  genus,
  flavorText,
  heightLabel,
  weightLabel,
  abilityCount,
  heroStyle,
  types,
  stats,
  statTotal,
  abilities,
  evolution,
  addProps,
  teamInitial,
}: DetailData) {
  return (
    <BrustPage lang="en" className="dark" title="PokéDex · detail">
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
            <a className="aa-nav-item is-active" href="/">
              <span>All Pokémon</span>
            </a>
            <a className="aa-nav-item" href="/type-chart">
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
              <b>{displayName}</b>
            </div>
          </header>

          <div className="aa-content">
            <a className="aa-btn aa-btn--ghost aa-btn--sm dex-back" href="/">
              ‹ Pokédex
            </a>

            <div className={notFoundClass}>
              <div className="dex-notfound__code">404</div>
              <h2 className="aa-h3">No Pokémon named “{displayName}”</h2>
              <p className="dex-notfound__desc">
                loader ได้ 404 จาก PokeAPI. brust ยังไม่มี notFound() sentinel — หน้านี้จึงตอบ HTTP 200 พร้อม
                body นี้ (ดู FRAMEWORK-GAPS.md §9).
              </p>
              <a className="aa-btn" href="/">
                ‹ Back to Pokédex
              </a>
            </div>

            <div className={contentClass}>
              <div className="aa-card dex-hero" style={heroStyle}>
                <div className="dex-hero__num">{num}</div>
                <h1 className="dex-hero__name">{displayName}</h1>
                <div className="dex-hero__genus">{genus}</div>
                <div className="dex-hero__art">
                  <img src={artwork} alt={displayName} className="dex-hero__img" />
                </div>
                <div className="dex-hero__types">
                  {types.map((t) => (
                    <span key={t.label} className={t.className}>
                      {t.label}
                    </span>
                  ))}
                </div>
                <Island component={AddToTeamButton} props={addProps} hydrate="load" />
              </div>

              <div className="dex-detail-right">
                <div className="aa-card aa-card--padded">
                  <p className="dex-flavor">{flavorText}</p>
                  <div className="dex-measures">
                    <div className="dex-measure">
                      <div className="dex-measure__v">{heightLabel}</div>
                      <div className="dex-measure__k">Height</div>
                    </div>
                    <div className="dex-measure">
                      <div className="dex-measure__v">{weightLabel}</div>
                      <div className="dex-measure__k">Weight</div>
                    </div>
                    <div className="dex-measure">
                      <div className="dex-measure__v">{abilityCount}</div>
                      <div className="dex-measure__k">Abilities</div>
                    </div>
                  </div>
                  <div className={abilitiesClass}>
                    {abilities.map((a) => (
                      <span key={a.displayName} className="aa-chip">
                        <span className="aa-chip__icon" style={a.iconStyle}>
                          {a.initial}
                        </span>
                        {a.displayName}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="aa-section dex-stats">
                  <div className="aa-section__head">
                    <h2 className="aa-section__title">Base stats</h2>
                    <span className="dex-stats__total">Σ {statTotal}</span>
                  </div>
                  <div className="aa-section__body dex-stats__body">
                    {stats.map((st) => (
                      <div key={st.label} className="dex-statbar">
                        <span className="dex-statbar__label">{st.label}</span>
                        <span className="dex-statbar__val">{st.base}</span>
                        <div className="dex-statbar__track">
                          <div className={st.barClassName} style={st.barWidth} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className={evoSectionClass}>
              <div className="aa-section__head">
                <div>
                  <h2 className="aa-section__title">Evolution chain</h2>
                  <div className="aa-section__desc">
                    โหลดใน loader (native route stream{' '}
                    <code className="dex-code">&lt;Suspense&gt;</code> ไม่ได้ — ดู GAPS §3)
                  </div>
                </div>
              </div>
              <div className="aa-section__body dex-evo__body">
                {evolution.map((s) => (
                  <div key={s.id} className="dex-evo__stage">
                    <div className={s.sepClassName}>
                      <span className="dex-evo__arrow">›</span>
                      <span className={s.levelClassName}>{s.levelLabel}</span>
                    </div>
                    <a className={s.cardClassName} href={s.detailHref}>
                      <img
                        className="dex-evo__img"
                        src={s.artwork}
                        alt={s.displayName}
                        loading="lazy"
                      />
                      <div className="dex-evo__num">{s.num}</div>
                      <div className="dex-evo__name">{s.displayName}</div>
                    </a>
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
