// Demo, native tier: the rule the build applies to a lucide icon's props that change at run time. The icon below is plain
// JSX (no package import, no network): its size, color and stroke width follow the selects, and "unset" is the same
// `undefined` a component can pass, which renders React's default exactly as the build-time lowering does
// (`size ?? 24`, `color ?? "currentColor"`, `strokeWidth ?? 2`). The readout shows the attributes the page would carry.
import { useEffect, useRef, useState } from 'react'

export default function IconAttrs() {
  const root = useRef<HTMLDivElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [size, setSize] = useState('16')
  const [color, setColor] = useState('')
  const [weight, setWeight] = useState('')
  const w = size === '' ? '24' : size
  const c = color === '' ? 'currentColor' : color
  const s = weight === '' ? '2' : weight
  return (
    <div className="builder grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3" ref={root}>
        <label className="grid gap-1 font-mono text-[12px] text-ink-2">
          size
          <select className="w-32 rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]" value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="">undefined</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="48">48</option>
          </select>
        </label>
        <label className="grid gap-1 font-mono text-[12px] text-ink-2">
          color
          <select className="w-32 rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]" value={color} onChange={(e) => setColor(e.target.value)}>
            <option value="">undefined</option>
            <option value="crimson">crimson</option>
            <option value="teal">teal</option>
          </select>
        </label>
        <label className="grid gap-1 font-mono text-[12px] text-ink-2">
          strokeWidth
          <select className="w-32 rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]" value={weight} onChange={(e) => setWeight(e.target.value)}>
            <option value="">undefined</option>
            <option value="1">1</option>
            <option value="3">3</option>
          </select>
        </label>
      </div>
      <div data-testid="icon-stage" style={{ display: 'grid', placeItems: 'center', minHeight: '4.5rem' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width={w} height={w} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={s} strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-heart" aria-hidden="true">
          <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
        </svg>
      </div>
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg">
        <code data-testid="icon-attrs">{`<Heart size={${size === '' ? 'undefined' : size}} color={${color === '' ? 'undefined' : `"${color}"`}} strokeWidth={${weight === '' ? 'undefined' : weight}} />\n\nwidth="${w}" height="${w}" stroke="${c}" stroke-width="${s}"`}</code>
      </pre>
    </div>
  )
}
