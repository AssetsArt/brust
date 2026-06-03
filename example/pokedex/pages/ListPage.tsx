// Route "/" — the Pokédex list. NATIVE leaf route: compiled to a minijinja
// template and rendered into AppLayout's <Outlet/> slot (chrome lives in
// AppLayout, nested as the parent in routes.tsx). The page therefore returns
// JUST its inner aa-content fragment — no <BrustPage>, no <main>: AppLayout owns
// the document shell and the single <main>.
//
// Native route components support `.map()` AND conditionals (S11): pagination
// "disabled" state is a real `{hasPrev ? <a/> : <span/>}` branch, not a
// precomputed hide-class. See ../FRAMEWORK-GAPS.md S11.
import type { ListData } from '../lib/types'

export default function ListPage({
  items,
  totalLabel,
  showingLabel,
  pageLabel,
  offsetLabel,
  hasPrev,
  hasNext,
  prevHref,
  nextHref,
}: ListData) {
  return (
    <>
      <div className="aa-page-header">
        <div>
          <h1 className="aa-page-header__title">Pokédex</h1>
          <div className="aa-page-header__desc">
            National Dex · {totalLabel} Pokémon · loader{' '}
            <code className="dex-code">GET /pokemon?limit=20&offset={offsetLabel}</code>
          </div>
        </div>
      </div>

      <div className="aa-alert aa-alert--info dex-note">
        <div className="aa-alert__body">
          List แสดงเฉพาะ number · name · artwork — types/stats โหลดตอนเปิด detail. artwork ถูก derive
          จาก id (ยิง PokeAPI ครั้งเดียวต่อหน้า) เพื่อเลี่ยง N+1 waterfall.
        </div>
      </div>

      <div className="dex-grid">
        {items.map((p) => (
          <a key={p.id} className="aa-card aa-card--interactive dex-card" href={p.detailHref}>
            <div className="dex-card__art">
              <span className="dex-card__num">{p.num}</span>
              <img className="dex-card__img" src={p.artwork} alt={p.displayName} loading="lazy" />
            </div>
            <div className="dex-card__body">{p.displayName}</div>
          </a>
        ))}
      </div>

      <div className="dex-pager">
        <div className="dex-pager__info">{showingLabel}</div>
        <div className="dex-pager__nav">
          {hasPrev ? (
            <a className="aa-btn aa-btn--secondary aa-btn--sm" href={prevHref}>
              ‹ Prev
            </a>
          ) : (
            <span className="aa-btn aa-btn--secondary aa-btn--sm dex-pager__btn--off">‹ Prev</span>
          )}
          <span className="dex-pager__page">{pageLabel}</span>
          {hasNext ? (
            <a className="aa-btn aa-btn--secondary aa-btn--sm" href={nextHref}>
              Next ›
            </a>
          ) : (
            <span className="aa-btn aa-btn--secondary aa-btn--sm dex-pager__btn--off">Next ›</span>
          )}
        </div>
      </div>
    </>
  )
}
