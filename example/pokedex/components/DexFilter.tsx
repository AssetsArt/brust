// NATIVE INTERACTIVE COMPONENT — the browse-page dex grid with live search +
// sort. The LOAD-BEARING dogfood of keyed `x-for` (0.1.28-alpha): the grid
// reconciles by `c.id` as the filtered/sorted list changes, no full re-render.
//
// Single-file native directive: `export const behavior` (react-free client
// logic) bundled into _directives.js as "dexFilter"; the JSX default lowered to
// minijinja. The full item list arrives as the loader-precomputed `x-props`
// JSON string (native templates can't call JSON.stringify), parsed into the
// behavior `props`. NO react imports — `signal`/`computed` from brustjs/store.
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
  const q = signal('')
  const sortAz = signal(false)
  const filtered = computed(() => {
    const needle = q().trim().toLowerCase()
    let out = needle ? all.filter((c) => c.name.includes(needle)) : all.slice()
    if (sortAz()) out = out.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  })
  const onInput = (e: Event) => q.set((e.target as HTMLInputElement).value)
  const setDex = () => sortAz.set(false)
  const setAz = () => sortAz.set(true)
  const countLabel = computed(() => `${filtered().length} / ${all.length}`)
  return { q, sortAz, filtered, onInput, setDex, setAz, countLabel }
}

export default function DexFilter({ data }: { data?: string }) {
  return (
    <section x-data="dexFilter" x-props={data}>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          x-on-input="onInput"
          placeholder="Search Pokémon…"
          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-white sm:max-w-xs"
        />
        <div className="flex items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              x-on-click="setDex"
              className="px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Dex#
            </button>
            <button
              type="button"
              x-on-click="setAz"
              className="border-l border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
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
        {/* biome-ignore lint/a11y/useValidAnchor: href is bound at hydration via x-bind-href (the template clone gets c.detailHref) */}
        <a
          x-for="c in filtered by c.id"
          x-bind-href="c.detailHref"
          className="group flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-3 no-underline shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-500/50 hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
        >
          <span
            x-text="c.num"
            className="self-start text-[11px] font-semibold tabular-nums text-slate-400"
          />
          {/* biome-ignore lint/a11y/useAltText: alt is bound at hydration via x-bind-alt (c.displayName) */}
          <img
            x-bind-src="c.artwork"
            x-bind-alt="c.displayName"
            loading="lazy"
            className="h-24 w-24 object-contain transition-transform group-hover:scale-110"
          />
          <div
            x-text="c.displayName"
            className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100"
          />
        </a>
      </div>
    </section>
  )
}
