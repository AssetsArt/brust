// Native leaf route "/pokemon/{name}" — the detail page. Renders into
// AppLayout's <Outlet/> slot (chrome lives in AppLayout). SINGLE return, NO
// local bindings — every formatted string / className / inline-style value /
// x-props JSON is precomputed in detailLoader.
//
// Native constraints: member-paths, `.map()`, inline conditionals
// (`{c ? a : b}` / `{c && x}`), and `style={{…}}` with member-path/literal
// values only. Type-tint colors and the hero gradient come from the loader as
// inline-style values (Tailwind can't scan runtime-built color classes). The
// evolution chain is loaded BLOCKING in the loader (native routes have no React
// tree, so <Suspense> streaming is impossible).
import { ArrowLeft, ChevronRight, Ruler, SearchX, Sigma, Weight } from 'lucide-react'
import AddToTeamButton from '../components/AddToTeamButton'
import Breadcrumb from '../components/Breadcrumb'
import type { DetailData } from '../lib/types'

export default function DetailPage({
  notFound,
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
}: DetailData) {
  return (
    <section className="py-2">
      <div className="mx-auto flex max-w-6xl items-center gap-1.5 px-4 pb-2 text-xs text-slate-400">
        <a href="/" className="no-underline hover:text-slate-600 dark:hover:text-slate-200">
          PokéDex
        </a>
        <ChevronRight size={14} isr={{ key: 'LcIconChevronRight14' }} />
        <Breadcrumb native crumb={displayName} />
      </div>
      {notFound ? (
        <div className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white px-6 py-16 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <SearchX size={48} className="mx-auto text-brand-500" isr={{ key: 'LcIconSearchX48' }} />
          <div className="mt-3 text-6xl font-black tracking-tighter text-brand-500">404</div>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            No Pokémon named “{displayName}”
          </h1>
          <p className="mt-2 text-slate-500 dark:text-slate-400">
            The Pokédex has no entry under that name. Check the spelling or browse the full list.
          </p>
          <a
            href="/pokedex"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white no-underline shadow-sm transition-colors hover:bg-brand-600"
          >
            <ArrowLeft size={16} isr={{ key: 'LcIconArrowLeft' }} />
            Back to Pokédex
          </a>
        </div>
      ) : (
        <div className="space-y-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div
              className="relative flex flex-col items-center overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:col-span-2"
              style={{ background: heroBg }}
            >
              <div className="self-start text-sm font-bold tabular-nums text-slate-400">{num}</div>
              <img
                src={artwork}
                alt={displayName}
                className="h-56 w-56 object-contain drop-shadow-xl"
              />
              <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
                {displayName}
              </h1>
              <div className="mt-1 text-sm font-medium text-slate-500 dark:text-slate-400">
                {genus}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {types.map((t) => (
                  <span
                    key={t.label}
                    style={{ background: t.color }}
                    className="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow-sm"
                  >
                    {t.label}
                  </span>
                ))}
              </div>
              <div className="mt-6 w-full max-w-xs">
                <AddToTeamButton native data={addProps} />
              </div>
            </div>

            <div className="space-y-6 lg:col-span-3">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <p className="text-slate-600 dark:text-slate-300">{flavorText}</p>
                <div className="mt-5 grid grid-cols-3 gap-3">
                  <div className="rounded-2xl bg-slate-50 px-3 py-3 text-center dark:bg-slate-800/60">
                    <div className="text-lg font-extrabold text-slate-900 dark:text-white">
                      {heightLabel}
                    </div>
                    <div className="flex items-center justify-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                      <Ruler size={12} isr={{ key: 'LcIconRuler12' }} />
                      Height
                    </div>
                  </div>
                  <div className="rounded-2xl bg-slate-50 px-3 py-3 text-center dark:bg-slate-800/60">
                    <div className="text-lg font-extrabold text-slate-900 dark:text-white">
                      {weightLabel}
                    </div>
                    <div className="flex items-center justify-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                      <Weight size={12} isr={{ key: 'LcIconWeight12' }} />
                      Weight
                    </div>
                  </div>
                  <div className="rounded-2xl bg-slate-50 px-3 py-3 text-center dark:bg-slate-800/60">
                    <div className="text-lg font-extrabold text-slate-900 dark:text-white">
                      {abilityCount}
                    </div>
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      Abilities
                    </div>
                  </div>
                </div>
                {hasAbilities && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {abilities.map((a) => (
                      <span
                        key={a.displayName}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-1 pr-3 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
                      >
                        <span
                          style={{ background: a.iconColor }}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
                        >
                          {a.initial}
                        </span>
                        {a.displayName}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-white">
                    Base stats
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                    <Sigma size={12} isr={{ key: 'LcIconSigma12' }} />
                    {statTotal}
                  </span>
                </div>
                <div className="space-y-3">
                  {stats.map((st) => (
                    <div
                      key={st.label}
                      className="grid grid-cols-[3rem_2.5rem_1fr] items-center gap-3"
                    >
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {st.label}
                      </span>
                      <span className="text-sm font-bold tabular-nums text-slate-700 dark:text-slate-200">
                        {st.base}
                      </span>
                      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className="h-full rounded-full"
                          style={{ width: st.barWidth, background: st.barColor }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {hasEvolution && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <h2 className="mb-5 text-lg font-extrabold tracking-tight text-slate-900 dark:text-white">
                Evolution chain
              </h2>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {evolution.map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    {s.isFirst ? (
                      <span />
                    ) : (
                      <div className="flex flex-col items-center px-1 text-slate-400">
                        <span className="text-xl leading-none">›</span>
                        {s.showLevel && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide">
                            {s.levelLabel}
                          </span>
                        )}
                      </div>
                    )}
                    {s.isCurrent ? (
                      <a
                        href={s.detailHref}
                        className="flex w-28 flex-col items-center rounded-2xl border-2 border-brand-500 bg-brand-50/60 p-3 no-underline shadow-sm dark:border-brand-500 dark:bg-brand-500/10"
                      >
                        <img
                          src={s.artwork}
                          alt={s.displayName}
                          loading="lazy"
                          className="h-20 w-20 object-contain"
                        />
                        <div className="text-[11px] font-semibold tabular-nums text-slate-400">
                          {s.num}
                        </div>
                        <div className="text-sm font-bold text-slate-900 dark:text-white">
                          {s.displayName}
                        </div>
                      </a>
                    ) : (
                      <a
                        href={s.detailHref}
                        className="flex w-28 flex-col items-center rounded-2xl border border-slate-200 bg-white p-3 no-underline shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-500/50 dark:border-slate-800 dark:bg-slate-900"
                      >
                        <img
                          src={s.artwork}
                          alt={s.displayName}
                          loading="lazy"
                          className="h-20 w-20 object-contain"
                        />
                        <div className="text-[11px] font-semibold tabular-nums text-slate-400">
                          {s.num}
                        </div>
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                          {s.displayName}
                        </div>
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
