// Demo, native tier: pick a starter and a template; the command to create the project follows.
import { useEffect, useRef, useState } from 'react'

export default function StarterPicker({ starters }: { starters: { id: string; label: string; sprite: string }[] }) {
  const root = useRef<HTMLFieldSetElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [name, setName] = useState(`${starters[0]!.id}-dex`)
  const [template, setTemplate] = useState('blank')
  return (
    <div className="starter">
      <fieldset className="m-0 mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-0 p-0" ref={root}>
        <legend className="mb-[.35rem] w-full p-0 font-mono text-[12px] text-ink-2">Starter</legend>
        {starters.map((s) => (
          <label key={s.id} className="choice inline-flex cursor-pointer items-center gap-[.4rem] text-[15px]">
            <input type="radio" className="accent-amber-fill" name="starter" checked={name === `${s.id}-dex`} onChange={() => setName(`${s.id}-dex`)} />
            <img src={s.sprite} alt="" width={40} height={40} loading="lazy" className="[image-rendering:pixelated]" />
            {s.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="m-0 mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-0 p-0">
        <legend className="mb-[.35rem] w-full p-0 font-mono text-[12px] text-ink-2">Template</legend>
        <label className="choice inline-flex cursor-pointer items-center gap-[.4rem] text-[15px]">
          <input type="radio" className="accent-amber-fill" name="template" checked={template === 'blank'} onChange={() => setTemplate('blank')} />
          blank
        </label>
        <label className="choice inline-flex cursor-pointer items-center gap-[.4rem] text-[15px]">
          <input type="radio" className="accent-amber-fill" name="template" checked={template === 'pokedex'} onChange={() => setTemplate('pokedex')} />
          pokedex
        </label>
      </fieldset>
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg">
        <code>{`$ bun create @brust/app@latest ${name} --template ${template}\n$ cd ${name} && bun install\n$ bun run dev`}</code>
      </pre>
    </div>
  )
}
