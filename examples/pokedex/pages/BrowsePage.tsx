import DexFilter from '../components/DexFilter'
import type { BrowseData } from '../lib/types'

export default function BrowsePage({ items, q }: BrowseData) {
  return (
    <section className="py-2">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">Pokédex</h1>
        <p className="mt-2 max-w-2xl text-slate-500 dark:text-slate-400">The original 151. Search by name and toggle the sort order.</p>
        {q && <p className="mt-2 text-sm text-slate-500">Results for “{q}”</p>}
      </div>
      <DexFilter items={items} />
    </section>
  )
}
