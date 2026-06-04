// Native leaf route "/pokedex" — the dex grid. Renders into AppLayout's
// <Outlet/> slot (chrome lives in AppLayout). SINGLE return, NO local bindings.
//
// The grid itself is the DexFilter native directive. The loader precomputes the
// full gen-1 item list two ways: `items` (the array → the SSR `{% for c in items %}`
// seed the compiler emits, so the 151 cards paint server-side) and `dexProps` (the
// same list as the client x-props JSON). DexFilter seeds a signal from props.items
// and owns search/sort + the keyed x-for reconcile that adopts the SSR'd nodes.
import DexFilter from '../components/DexFilter'
import type { BrowseData } from '../lib/types'

export default function BrowsePage({ items, dexProps }: BrowseData) {
  return (
    <section className="py-2">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          Pokédex
        </h1>
        <p className="mt-2 max-w-2xl text-slate-500 dark:text-slate-400">
          The original 151. Search by name and toggle sort order — the grid reconciles live with a
          keyed{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm dark:bg-slate-800">
            x-for
          </code>
          , no full re-render.
        </p>
      </div>
      <DexFilter native items={items} data={dexProps} />
    </section>
  )
}
