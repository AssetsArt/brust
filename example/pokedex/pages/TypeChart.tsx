// Route "/type-chart" — NATIVE route. A static 18×18 type-effectiveness matrix:
// pure read-only data, the ideal native page (compiled to jinja, rendered in
// Rust, zero React on the server). The 19×19 grid is pre-flattened in the loader
// to a single row-major `cells` array so the template uses ONE `.map()` into a
// CSS grid (nested maps aren't proven on the native path — see GAPS S10).
import PageLayout from '../components/PageLayout'
import type { TypeChartData } from '../lib/types'

export default function TypeChart({ cells, teamProps }: TypeChartData) {
  return (
    <PageLayout
      native
      title="PokéDex · type chart"
      active="typechart"
      crumb="Type chart"
      teamProps={teamProps}
    >
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
          {cells.map((c) => (
            <div key={c.id} className={c.className} title={c.title}>
              {c.content}
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  )
}
