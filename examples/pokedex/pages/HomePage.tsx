import HeroSearch from '../components/HeroSearch'
import TypeBadge from '../components/TypeBadge'
import type { HomeData } from '../lib/types'

export default function HomePage({ featured, types }: HomeData) {
  return (
    <div className="space-y-16 py-4">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 via-brand-600 to-indigo-700 px-6 py-16 text-center shadow-xl sm:px-12">
        <span className="inline-flex items-center rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white/90 ring-1 ring-white/20">
          Built with brust
        </span>
        <h1 className="mx-auto mt-5 max-w-2xl text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Every Pokémon, one fast native-rendered Pokédex.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-white/85 sm:text-lg">
          Browse the National Dex, study the type chart, and build your dream team — server-rendered
          in Rust, hydrated only where it counts.
        </p>
        <HeroSearch />
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/pokedex"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 no-underline shadow-sm transition-transform hover:-translate-y-0.5"
          >
            Browse Pokédex
          </a>
          <a
            href="/type-chart"
            className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-5 py-2.5 text-sm font-semibold text-white no-underline ring-1 ring-white/30 transition-colors hover:bg-white/25"
          >
            Type chart
          </a>
        </div>
      </section>

      <section>
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Featured
          </h2>
          <a
            href="/pokedex"
            className="inline-flex items-center gap-1 text-sm font-semibold text-brand-600 no-underline hover:underline dark:text-brand-50"
          >
            View all
          </a>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {featured.map((p) => (
            <a
              key={p.id}
              href={p.detailHref}
              className="group flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-4 no-underline shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-500/50 hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
            >
              <span className="self-start text-[11px] font-semibold tabular-nums text-slate-400">
                {p.num}
              </span>
              <img
                src={p.artwork}
                alt={p.displayName}
                loading="lazy"
                className="h-28 w-28 object-contain transition-transform group-hover:scale-110"
              />
              <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {p.displayName}
              </div>
            </a>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-5 text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          Browse by type
        </h2>
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
          {types.map((t) => (
            <a key={t} href="/pokedex" className="flex items-center justify-center no-underline">
              <TypeBadge type={t} />
            </a>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
              Build your team
            </h2>
            <p className="mt-2 max-w-md text-slate-500 dark:text-slate-400">
              Add up to six Pokémon from any detail page. Your team lives in the floating dock and
              follows you across the whole site.
            </p>
          </div>
          <a
            href="/pokedex"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white no-underline shadow-sm transition-colors hover:bg-brand-600"
          >
            Start picking
          </a>
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          Built with brust
        </h2>
        <p className="mb-6 max-w-2xl text-slate-500 dark:text-slate-400">
          This whole site is one brust app, served from an offline PokeAPI snapshot.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-bold text-slate-900 dark:text-white">Native SSR routes</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Pages compile to templates and render in Rust.</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-bold text-slate-900 dark:text-white">Loaders + cache</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Loaders run in Bun; responses are cached by tag.</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-bold text-slate-900 dark:text-white">React islands</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">The team dock hydrates as a React child while the page stays static.</div>
          </div>
        </div>
      </section>
    </div>
  )
}
