// Demo (client-only): the cache-key rules of the server, evaluated in the browser by lib/cache-key.ts. Pick an example or type an expression,
// describe a request, and see the evaluated prefix and the key parts (or the parse error, or BYPASS).
import { useReducer, useTransition } from 'react'
import { evaluatePlayground } from '../../lib/cache-key'

export interface Preset {
  id: string
  label: string
  prefix: string
  bypass: string
  url: string
  host: string
  cookies: string
  headers: string
  params: string
}

type Form = Omit<Preset, 'id' | 'label'> & { env: string }
type Action = { set: keyof Form; value: string } | { preset: Preset }

// One reducer holds the whole form. (useTransition, a hook the native tier does not compile, keeps this a React island: the evaluation
// below is a call into lib/cache-key.ts and has to run in the browser on every keystroke.)
function reduce(f: Form, a: Action): Form {
  if ('preset' in a) {
    const { id: _id, label: _label, ...rest } = a.preset
    return { ...f, ...rest }
  }
  return { ...f, [a.set]: a.value }
}

function initial(presets: Preset[]): Form {
  const { id: _id, label: _label, ...rest } = presets[0]!
  return { ...rest, env: 'BUILD_ID=r1' }
}

export default function CacheKeyPlayground({ presets }: { presets: Preset[] }) {
  useTransition() // keeps this a React island: the native tier does not compile it
  const [f, dispatch] = useReducer(reduce, presets, initial)
  const r = evaluatePlayground(f)
  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)] items-end gap-x-4 gap-y-3">
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Example
          <select
            className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]"
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value)
              if (p) dispatch({ preset: p })
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
        prefix
        <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.prefix} onChange={(e) => dispatch({ set: 'prefix', value: e.target.value })} spellCheck={false} />
      </label>
      <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
        bypass (an expression, or true)
        <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.bypass} onChange={(e) => dispatch({ set: 'bypass', value: e.target.value })} spellCheck={false} />
      </label>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] items-end gap-x-4 gap-y-3">
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Path and query
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.url} onChange={(e) => dispatch({ set: 'url', value: e.target.value })} spellCheck={false} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Host
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.host} onChange={(e) => dispatch({ set: 'host', value: e.target.value })} spellCheck={false} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Cookies (a=1; b=2)
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.cookies} onChange={(e) => dispatch({ set: 'cookies', value: e.target.value })} spellCheck={false} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Route params (name=pikachu)
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.params} onChange={(e) => dispatch({ set: 'params', value: e.target.value })} spellCheck={false} />
        </label>
      </div>
      <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
        Headers (one name: value per line)
        <textarea className="resize-y w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" rows={2} value={f.headers} onChange={(e) => dispatch({ set: 'headers', value: e.target.value })} spellCheck={false} />
      </label>
      <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
        Process env when the server started (NAME=value per line)
        <textarea className="resize-y w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" rows={1} value={f.env} onChange={(e) => dispatch({ set: 'env', value: e.target.value })} spellCheck={false} />
      </label>
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg" aria-live="polite">
        <code>
          {r.ok === false
            ? `parse error: ${r.error}`
            : r.outcome === 'BYPASS'
              ? `x-brust-cache: BYPASS\n(${r.why}: the page is neither read from nor stored in the cache)`
              : `prefix  ${JSON.stringify(r.prefix)}\nmethod  ${r.key.method}\npath    ${r.key.path}\nquery   ${JSON.stringify(r.key.sortedQuery)}`}
        </code>
      </pre>
    </div>
  )
}
