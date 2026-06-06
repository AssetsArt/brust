// Native leaf route "/type-chart" — the 18×18 type-effectiveness matrix.
// Renders into AppLayout's <Outlet/> slot (chrome lives in AppLayout). SINGLE
// return, NO local bindings. Pure read-only data → the ideal native page
// (compiled to jinja, rendered in Rust, zero React on the server).
//
// The 19×19 grid uses nested `.map()`: rows.map(r => r.cells.map(c => …)) into a
// CSS grid. Each row wrapper is `display:contents` (Tailwind `contents`) so
// every cell is a direct grid item — the row div leaves no box. Cell coloring
// is a static Tailwind utility class string the loader picks per effectiveness
// (literals in a .ts file, so `@source` scans them). The header row + row heads
// are `sticky` (also set in the loader class strings).
import type { TypeChartData } from '../lib/types'

export default function TypeChart({ rows }: TypeChartData) {
  return (
    <section className="py-2">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          Type chart
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          Damage relations — read a row (attacker) across to a column (defender). Rendered
          server-side in Rust from jinja (native:true · no React runtime in the payload).
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2.5 text-sm">
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-emerald-500 text-xs font-bold text-white">
            2
          </span>
          super effective
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-rose-400 text-xs font-bold text-white dark:bg-rose-500">
            ½
          </span>
          not very effective
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-800 text-xs font-bold text-slate-100 dark:bg-slate-950 dark:text-slate-400">
            0
          </span>
          no effect
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <span className="h-5 w-5 rounded bg-slate-50 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700" />
          normal (1×)
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="grid w-full grid-cols-[2.75rem_repeat(18,minmax(1.75rem,1fr))] gap-px overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-700">
          {rows.map((r) => (
            <div key={r.id} className="contents">
              {r.cells.map((c) => (
                <div
                  key={c.id}
                  className={c.className}
                  title={c.title}
                  style={{ background: c.bg }}
                >
                  {c.content}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
