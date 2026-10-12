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
      <fieldset className="choices" ref={root}>
        <legend>Starter</legend>
        {starters.map((s) => (
          <label key={s.id} className="choice">
            <input type="radio" name="starter" checked={name === `${s.id}-dex`} onChange={() => setName(`${s.id}-dex`)} />
            <img src={s.sprite} alt="" width={40} height={40} loading="lazy" />
            {s.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>Template</legend>
        <label className="choice">
          <input type="radio" name="template" checked={template === 'blank'} onChange={() => setTemplate('blank')} />
          blank
        </label>
        <label className="choice">
          <input type="radio" name="template" checked={template === 'pokedex'} onChange={() => setTemplate('pokedex')} />
          pokedex
        </label>
      </fieldset>
      <pre className="cmd">
        <code>{`$ bun create @brust/app@latest ${name} --template ${template}\n$ cd ${name} && bun install\n$ bun run dev`}</code>
      </pre>
    </div>
  )
}
