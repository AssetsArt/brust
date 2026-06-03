// Route "/type-chart" — NATIVE leaf route, rendered into AppLayout's <Outlet/>
// slot (chrome lives in AppLayout). Returns JUST its inner aa-content fragment.
// A static 18×18 type-effectiveness matrix: pure read-only data, the ideal
// native page (compiled to jinja, rendered in Rust, zero React on the server).
// The 19×19 grid uses nested `.map()` on the native path: rows.map(r =>
// r.cells.map(c => …)) into a CSS grid.
import type { TypeChartData } from '../lib/types'

export default function TypeChart({ rows }: TypeChartData) {
  return (
    <>
      <div className="aa-page-header">
        <div>
          <h1 className="aa-page-header__title">Type chart</h1>
          <div className="aa-page-header__desc">
            Damage relations · row attacks column · rendered ฝั่ง Rust จาก jinja (native:true · ไม่มี
            React runtime ใน payload)
          </div>
        </div>
      </div>

      <div className="dex-tc-legend">
        <span className="dex-tc-legend__item">
          <span className="dex-tc__cell dex-tc__cell--super dex-tc__swatch">2</span> super effective
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
          {rows.map((r) => (
            <div key={r.id} className="dex-tc__row">
              {r.cells.map((c) => (
                <div key={c.id} className={c.className} title={c.title}>
                  {c.content}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
