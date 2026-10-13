// Demo (client-only): the cache-key rules of the server, evaluated in the browser by lib/cache-key.ts. Pick an example or type an expression,
// describe a request, and see the evaluated prefix and the key parts (or the parse error, or BYPASS).
import { useReducer } from 'react'
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

// One reducer holds the whole form. (useReducer is a hook the native tier does not compile, so this stays a React island: the evaluation
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
  const [f, dispatch] = useReducer(reduce, presets, initial)
  const r = evaluatePlayground(f)
  return (
    <div className="builder keypg">
      <div className="fields">
        <label>
          Example
          <select
            className="demo-in"
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
      <label>
        prefix
        <input className="demo-in" value={f.prefix} onChange={(e) => dispatch({ set: 'prefix', value: e.target.value })} spellCheck={false} />
      </label>
      <label>
        bypass (an expression, or true)
        <input className="demo-in" value={f.bypass} onChange={(e) => dispatch({ set: 'bypass', value: e.target.value })} spellCheck={false} />
      </label>
      <div className="fields">
        <label>
          Path and query
          <input className="demo-in" value={f.url} onChange={(e) => dispatch({ set: 'url', value: e.target.value })} spellCheck={false} />
        </label>
        <label>
          Host
          <input className="demo-in" value={f.host} onChange={(e) => dispatch({ set: 'host', value: e.target.value })} spellCheck={false} />
        </label>
        <label>
          Cookies (a=1; b=2)
          <input className="demo-in" value={f.cookies} onChange={(e) => dispatch({ set: 'cookies', value: e.target.value })} spellCheck={false} />
        </label>
        <label>
          Route params (name=pikachu)
          <input className="demo-in" value={f.params} onChange={(e) => dispatch({ set: 'params', value: e.target.value })} spellCheck={false} />
        </label>
      </div>
      <label>
        Headers (one name: value per line)
        <textarea className="demo-in" rows={2} value={f.headers} onChange={(e) => dispatch({ set: 'headers', value: e.target.value })} spellCheck={false} />
      </label>
      <label>
        Process env when the server started (NAME=value per line)
        <textarea className="demo-in" rows={1} value={f.env} onChange={(e) => dispatch({ set: 'env', value: e.target.value })} spellCheck={false} />
      </label>
      <pre className="cmd" aria-live="polite">
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
