import { useState } from 'react'

export default function CatchCard({ no, name, art, shinyArt }: { no: string; name: string; art: string; shinyArt: string }) {
  const [caught, setCaught] = useState(0)
  const [shiny, setShiny] = useState(false)
  const [log, setLog] = useState<{ id: number; name: string; from: string; to: string }[]>([])
  const [wiggle, setWiggle] = useState(false)
  return (
    <div className="grid min-h-60 [.doc_&]:min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,13rem)] items-stretch gap-4 p-5 max-narrow:grid-cols-1">
      <article className="grid min-w-0 content-start gap-[.6rem] rounded-xs border border-rule bg-paper p-[.9rem]">
        <div className="grid place-items-center rounded-lg bg-sheet p-[.4rem]">
          <img className={wiggle ? 'aspect-square h-auto w-full max-w-[170px] motion-safe:[transition:opacity_.2s] motion-safe:animate-mirai-wiggle' : 'aspect-square h-auto w-full max-w-[170px] motion-safe:[transition:opacity_.2s]'} src={shiny ? shinyArt : art} alt={shiny ? 'Shiny ' + name : name} width="200" height="200" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-ink-2">{no}</span>
          <h4 className="m-0 mr-auto font-display text-[1.05rem]">{name}</h4>
          <span className="rounded-full bg-ty-electric px-2 py-[.05rem] font-mono text-[11px] text-ty-dark-fg">electric</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[14.5px] select-none" htmlFor="cc-shiny">
            <input
              type="checkbox"
              className="peer absolute size-px opacity-0"
              id="cc-shiny"
              checked={shiny}
              onChange={() => {
                setLog([{ id: Date.now(), name: 'shiny', from: String(shiny), to: String(!shiny) }, ...log].slice(0, 6))
                setShiny(!shiny)
              }}
            />
            <span className="relative h-5 w-[2.2rem] flex-none rounded-full bg-rule peer-checked:bg-amber-fill peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-amber after:absolute after:top-[2px] after:left-[2px] after:size-[calc(1.25rem-4px)] after:rounded-full after:bg-sheet after:shadow-[0_1px_2px_rgba(0,0,0,.25)] after:content-[''] peer-checked:after:[transform:translateX(.95rem)] motion-safe:[transition:background_.2s,transform_.2s_cubic-bezier(.2,.7,.2,1)] motion-safe:after:[transition:background_.2s,transform_.2s_cubic-bezier(.2,.7,.2,1)]" aria-hidden="true" />
            Shiny
          </label>
          <button
            type="button"
            className="cursor-pointer rounded-xs border border-amber-fill bg-amber-fill px-4 py-[.55rem] text-on-amber [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold tabular-nums motion-safe:[transition:transform_.1s] motion-safe:active:[transform:scale(.97)]"
            onClick={() => {
              setLog([{ id: Date.now(), name: 'caught', from: String(caught), to: String(caught + 1) }, ...log].slice(0, 6))
              setCaught(caught + 1)
              setWiggle(true)
              setTimeout(() => setWiggle(false), 450)
            }}
          >
            Catch · <span className="inline-block min-w-[1ch]">{caught}</span>
          </button>
        </div>
      </article>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xs border border-term-rule bg-term font-mono text-[12.5px] text-term-fg">
        <div className="flex justify-between gap-2 border-b border-term-rule px-[.7rem] py-[.45rem] text-[11.5px] text-term-dim">
          <span className="text-amber">Signals</span>
          <span>no re-render</span>
        </div>
        <ol className="m-0 grid list-none content-start gap-[.35rem] px-[.7rem] py-2 [.doc_&]:pl-[1.4rem]" aria-live="polite">
          {log.length === 0 ? <li className="text-term-dim">Use the switch or the button.</li> : null}
          {log.map((e) => (
            <li key={e.id} className="flex justify-between gap-2 whitespace-nowrap motion-safe:animate-mirai-slidein">
              <b className="font-normal text-sy-fn">{e.name}</b>
              <span className="text-term-dim">
                {e.from} → <em className="not-italic text-sy-str">{e.to}</em>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
