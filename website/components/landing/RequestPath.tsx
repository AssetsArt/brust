// "What happens to one request": the serving path of a real route on this site (/demo/pokemon/{name}, cached 60 s),
// step by step, with a MISS/HIT switch that dims what a cache hit skips. Steps follow pages/docs/Introduction.tsx#request.
import { useState } from 'react'
import SecHead from './SecHead'

export default function RequestPath() {
  const [hit, setHit] = useState(false)
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto max-w-[1160px] px-4">
        <SecHead title="What happens to one request" lede="Rust receives every request and writes every response. Bun runs your loaders, and is skipped when the cache already has the page." />
        <div className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <code className="text-[15px] text-ink">GET /demo/pokemon/pikachu</code>
          <div className="inline-flex rounded-full border border-rule bg-sheet p-[3px]" role="group" aria-label="Cache state">
            <button type="button" className="cursor-pointer rounded-full border-0 bg-transparent px-[.95rem] py-[.35rem] text-ink-2 [font-family:inherit] [font-weight:inherit] [line-height:inherit] text-[14px] aria-pressed:bg-amber-fill aria-pressed:text-on-amber focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-ink motion-safe:[transition:background_.25s_var(--ease),color_.25s_var(--ease)]" aria-pressed={!hit} onClick={() => setHit(false)}>
              First request
            </button>
            <button type="button" className="cursor-pointer rounded-full border-0 bg-transparent px-[.95rem] py-[.35rem] text-ink-2 [font-family:inherit] [font-weight:inherit] [line-height:inherit] text-[14px] aria-pressed:bg-amber-fill aria-pressed:text-on-amber focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-ink motion-safe:[transition:background_.25s_var(--ease),color_.25s_var(--ease)]" aria-pressed={hit} onClick={() => setHit(true)}>
              Again within 60 s
            </button>
          </div>
        </div>
        <ol className={hit ? "group/path hit relative m-0 grid list-none grid-cols-5 gap-6 p-0 before:absolute before:inset-x-0 before:top-3 before:h-[2px] before:bg-amber before:content-[''] max-wide:grid-cols-1 max-wide:gap-5 max-wide:pl-5 max-wide:before:right-auto max-wide:before:left-0 max-wide:before:top-[.3rem] max-wide:before:bottom-[.3rem] max-wide:before:h-auto max-wide:before:w-[2px]" : "group/path relative m-0 grid list-none grid-cols-5 gap-6 p-0 before:absolute before:inset-x-0 before:top-3 before:h-[2px] before:bg-amber before:content-[''] max-wide:grid-cols-1 max-wide:gap-5 max-wide:pl-5 max-wide:before:right-auto max-wide:before:left-0 max-wide:before:top-[.3rem] max-wide:before:bottom-[.3rem] max-wide:before:h-auto max-wide:before:w-[2px]"}>
          <li className="relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)]">
            <span className="relative z-10 justify-self-start rounded-full border-2 px-[.7rem] py-[.4rem] text-[12.5px] leading-none font-bold border-amber-fill bg-amber-fill text-on-amber">Rust</span>
            <h3 className="text-[1.1rem] leading-[1.3] font-semibold">Match the route</h3>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2">
              <code className="whitespace-nowrap">/demo/pokemon/{'{name}'}</code>, with <code className="whitespace-nowrap">name = pikachu</code>.
            </p>
          </li>
          <li className="relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)]">
            <span className="relative z-10 justify-self-start rounded-full border-2 px-[.7rem] py-[.4rem] text-[12.5px] leading-none font-bold border-amber-fill bg-amber-fill text-on-amber">Rust</span>
            <h3 className="text-[1.1rem] leading-[1.3] font-semibold">Check the cache</h3>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2 group-[.hit]/path:hidden">Nothing stored yet for this URL.</p>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2 hidden group-[.hit]/path:block">A fresh copy is in memory. It is sent as is.</p>
          </li>
          <li className={hit ? 'relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)] opacity-[.32] [&_h3]:line-through [&_h3]:decoration-1' : 'relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)]'}>
            <span className="relative z-10 justify-self-start rounded-full border-2 px-[.7rem] py-[.4rem] text-[12.5px] leading-none font-bold border-amber bg-sheet text-ink">Bun</span>
            <h3 className="text-[1.1rem] leading-[1.3] font-semibold">Run the loaders</h3>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2">Layout first, then the page. Their results become the page's props.</p>
          </li>
          <li className={hit ? 'relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)] opacity-[.32] [&_h3]:line-through [&_h3]:decoration-1' : 'relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)]'}>
            <span className="relative z-10 justify-self-start rounded-full border-2 px-[.7rem] py-[.4rem] text-[12.5px] leading-none font-bold border-amber-fill bg-amber-fill text-on-amber">Rust</span>
            <h3 className="text-[1.1rem] leading-[1.3] font-semibold">Render the page</h3>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2">From templates compiled at build time, then stored for 60 seconds.</p>
          </li>
          <li className="relative grid min-w-0 content-start gap-[.45rem] motion-safe:[transition:opacity_.35s_var(--ease)]">
            <span className="relative z-10 justify-self-start rounded-full border-2 px-[.7rem] py-[.4rem] text-[12.5px] leading-none font-bold border-ink-2 bg-sheet text-ink">Browser</span>
            <h3 className="text-[1.1rem] leading-[1.3] font-semibold">Gets HTML</h3>
            <p className="m-0 text-[15px] leading-[1.6] text-ink-2">
              <span className="group-[.hit]/path:hidden">
                <code className="whitespace-nowrap">x-brust-cache: MISS</code>.
              </span>
              <span className="hidden group-[.hit]/path:inline">
                <code className="whitespace-nowrap">x-brust-cache: HIT</code>.
              </span>{' '}
              No script tag: nothing on this page is interactive.
            </p>
          </li>
        </ol>
      </div>
    </section>
  )
}
