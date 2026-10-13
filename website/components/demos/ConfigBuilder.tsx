// Demo, native tier: set the pokedex server's port, workers and actions; the brust.toml and the equivalent
// environment override follow (env beats flags beats brust.toml beats defaults).
import { useEffect, useRef, useState } from 'react'

export default function ConfigBuilder() {
  const root = useRef<HTMLDivElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [port, setPort] = useState('1337')
  const [workers, setWorkers] = useState('4')
  const [actions, setActions] = useState(true)
  return (
    <div className="builder grid min-w-0 gap-3">
      <div className="fields flex flex-wrap items-end gap-x-4 gap-y-3" ref={root}>
        <label className="grid gap-1 font-mono text-[12px] text-ink-2">
          Port
          <input className="w-32 rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
        </label>
        <label className="grid gap-1 font-mono text-[12px] text-ink-2">
          Workers
          <input className="w-32 rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]" inputMode="numeric" value={workers} onChange={(e) => setWorkers(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1 font-text text-[14.5px] text-ink select-none">
          <input type="checkbox" className="peer absolute h-px w-px opacity-0" checked={actions} onChange={(e) => setActions(e.target.checked)} />
          <span className="relative h-5 w-[2.2rem] flex-none rounded-full bg-rule peer-checked:bg-amber-fill peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-amber motion-safe:transition-[background-color] motion-safe:duration-200 after:absolute after:top-[2px] after:left-[2px] after:size-[calc(1.25rem-4px)] after:rounded-full after:bg-sheet after:shadow-[0_1px_2px_rgba(0,0,0,.25)] after:content-[''] peer-checked:after:translate-x-[.95rem] motion-safe:after:transition-transform motion-safe:after:duration-200 motion-safe:after:ease-[cubic-bezier(.2,.7,.2,1)]" aria-hidden="true" />
          Actions
        </label>
      </div>
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg">
        <code>{`# pokedex/brust.toml\n[server]\naddress = "127.0.0.1"\nport = ${port || '1337'}\n\n[workers]\ncount = ${workers || '1'}${actions ? '\n\n[actions]' : ''}`}</code>
      </pre>
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg">
        <code>{`# the same, for one run, without editing the file\n$ BRUST_PORT=${port || '1337'} BRUST_WORKERS=${workers || '1'} bun run start`}</code>
      </pre>
    </div>
  )
}
