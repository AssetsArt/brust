// Route "/pokemon/{name}" — NATIVE detail page. Per the decision to push native
// as far as possible, the evolution chain is loaded BLOCKING in the loader (a
// native/jinja route has no React tree, so <Suspense> streaming is impossible —
// see ../FRAMEWORK-GAPS.md S3).
//
// Native routes now support conditionals (S11): the page uses a real
// `{notFound ? <NotFound/> : <Content/>}` branch, `{hasAbilities && …}` /
// `{hasEvolution && …}` sections, and per-item `{!s.isFirst && <Arrow/>}` /
// `{s.showLevel && <Level/>}` separators — no more loader-computed hide-classes.
// The <title> is dynamic via `<BrustPage title={pageTitle}>` (S8) and inline
// styles use `style={{…}}` objects (S1).
import AddToTeamButton from '../components/AddToTeamButton'
import PageLayout from '../components/PageLayout'
import type { DetailData } from '../lib/types'

export default function DetailPage({
  notFound,
  pageTitle,
  hasAbilities,
  hasEvolution,
  displayName,
  num,
  artwork,
  genus,
  flavorText,
  heightLabel,
  weightLabel,
  abilityCount,
  heroBg,
  types,
  stats,
  statTotal,
  abilities,
  evolution,
  addProps,
  teamProps,
}: DetailData) {
  return (
    <PageLayout native title={pageTitle} active="list" crumb={displayName} teamProps={teamProps}>
      <a className="aa-btn aa-btn--ghost aa-btn--sm dex-back" href="/">
        ‹ Pokédex
      </a>

      {notFound ? (
        <div className="dex-notfound">
          <div className="dex-notfound__code">404</div>
          <h2 className="aa-h3">No Pokémon named “{displayName}”</h2>
          <p className="dex-notfound__desc">
            loader ได้ 404 จาก PokeAPI. brust ยังไม่มี notFound() sentinel — หน้านี้จึงตอบ HTTP 200 พร้อม
            body นี้ (ดู FRAMEWORK-GAPS.md S9).
          </p>
          <a className="aa-btn" href="/">
            ‹ Back to Pokédex
          </a>
        </div>
      ) : (
        <>
          <div className="dex-detail-grid">
            <div className="aa-card dex-hero" style={{ background: heroBg }}>
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
              <AddToTeamButton native data={addProps} />
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
                {hasAbilities && (
                  <div className="dex-abilities">
                    {abilities.map((a) => (
                      <span key={a.displayName} className="aa-chip">
                        <span className="aa-chip__icon" style={{ background: a.iconColor }}>
                          {a.initial}
                        </span>
                        {a.displayName}
                      </span>
                    ))}
                  </div>
                )}
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
                        <div className={st.barClassName} style={{ width: st.barWidth }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {hasEvolution && (
            <div className="aa-section dex-evo">
              <div className="aa-section__head">
                <div>
                  <h2 className="aa-section__title">Evolution chain</h2>
                  <div className="aa-section__desc">
                    โหลดใน loader (native route stream{' '}
                    <code className="dex-code">&lt;Suspense&gt;</code> ไม่ได้ — ดู GAPS S3)
                  </div>
                </div>
              </div>
              <div className="aa-section__body dex-evo__body">
                {evolution.map((s) => (
                  <div key={s.id} className="dex-evo__stage">
                    {!s.isFirst && (
                      <div className="dex-evo__sep">
                        <span className="dex-evo__arrow">›</span>
                        {s.showLevel && <span className="dex-evo__lv">{s.levelLabel}</span>}
                      </div>
                    )}
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
          )}
        </>
      )}
    </PageLayout>
  )
}
