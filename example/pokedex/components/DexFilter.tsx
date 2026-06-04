// NATIVE INTERACTIVE COMPONENT — the browse-page dex grid with live search +
// sort. The LOAD-BEARING dogfood of keyed `x-for` (0.1.28-alpha): the grid
// reconciles by `c.id` as the filtered/sorted list changes, no full re-render.
//
// Single-file native directive: `export const behavior` (react-free client
// logic) bundled into _directives.js as "dexFilter"; the JSX default lowered to
// minijinja. The full item list arrives as the loader-precomputed `x-props`
// JSON string (native templates can't call JSON.stringify), parsed into the
// behavior `props`. NO react imports — `signal`/`computed` from brustjs/store.
import { ArrowDownAZ, Hash, Search } from 'lucide-react'
import { computed, signal } from 'brustjs/store'

interface Card {
  id: number
  name: string
  displayName: string
  num: string
  artwork: string
  detailHref: string
}

export const behavior = ({ props }: { el: HTMLElement; props: unknown }) => {
  const all = ((props as { items?: Card[] })?.items ?? []) as Card[]
  const items = signal(all) // seeded to the SAME data as the SSR {% for %}
  const q = signal('')
  const sortAz = signal(false)
  const apply = () => {
    const needle = q().trim().toLowerCase()
    let out = needle ? all.filter((c) => c.name.includes(needle)) : all.slice()
    if (sortAz()) out = out.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    items.set(out)
  }
  const onInput = (e: Event) => {
    q.set((e.target as HTMLInputElement).value)
    apply()
  }
  const setDex = () => {
    sortAz.set(false)
    apply()
  }
  const setAz = () => {
    sortAz.set(true)
    apply()
  }
  const countLabel = computed(() => `${items().length} / ${all.length}`)
  return { items, q, sortAz, onInput, setDex, setAz, countLabel }
}

// `items` is the loader array, written as an idiomatic `.map()` carrying a bare
// `x-for` flag + React `key` — the compiler sugar desugars it to the SSR adopt
// seed ({% for c in items %} + data-x-key + x-bind-href). `data` is the client
// x-props JSON the behavior reads; the behavior re-exposes `items` as a signal.
export default function DexFilter({ items, data }: { items: Card[]; data?: string }) {
  return (
    <section x-data="dexFilter" x-props={data}>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            isr={{ key: 'LcIconSearchField' }}
          />
          <input
            type="search"
            x-on-input="onInput"
            placeholder="Search Pokémon…"
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              x-on-click="setDex"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Hash size={14} isr={{ key: 'LcIconHash14' }} />
              Dex#
            </button>
            <button
              type="button"
              x-on-click="setAz"
              className="inline-flex items-center gap-1.5 border-l border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ArrowDownAZ size={14} isr={{ key: 'LcIconArrowDownAZ14' }} />
              A–Z
            </button>
          </div>
          <span
            x-text="countLabel"
            className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {items.map((c) => (
          <a
            x-for
            key={c.id}
            href={c.detailHref}
            className="group flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-3 no-underline shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-500/50 hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
          >
            <span className="self-start text-[11px] font-semibold tabular-nums text-slate-400">
              {c.num}
            </span>
            <img
              src={c.artwork}
              alt={c.displayName}
              loading="lazy"
              className="h-24 w-24 object-contain transition-transform group-hover:scale-110"
            />
            <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {c.displayName}
            </div>
          </a>
        ))}
      </div>
    </section>
  )
}
