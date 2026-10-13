// Demo (client-only): a page on one origin calling actions on another. Set both deployments' settings and see, step by
// step, what the browser and the actions server do: the preflight, the credentials rule, the cross-site guard. The
// rules are components/demos/cross-origin.ts, evaluated in your browser; nothing is sent.
import { useReducer } from 'react'
import { type CrossOriginInput, checkCrossOrigin } from './cross-origin'

type Action = { set: keyof CrossOriginInput; value: string | boolean }

// One reducer holds the form. (useReducer is a hook the native tier does not compile, so this stays a React island: the
// check below is a call into cross-origin.ts and runs on every change.)
function reduce(f: CrossOriginInput, a: Action): CrossOriginInput {
  return { ...f, [a.set]: a.value }
}

const START: CrossOriginInput = {
  page: 'https://app.example.com',
  actions: 'https://api.example.com',
  corsOrigins: 'https://app.example.com',
  corsCredentials: true,
  credentials: 'include',
  method: 'POST',
  crossSite: 'reject',
}

const BADGE: Record<string, string> = {
  ok: 'reaches your app',
  blocked: 'blocked by the browser',
  rejected: '403 from the server',
  'boot-error': 'the server does not start',
  invalid: 'not an origin',
}

export default function CrossOriginCheck() {
  const [f, set] = useReducer(reduce, START)
  const r = checkCrossOrigin(f)
  const text = (k: keyof CrossOriginInput) => (e: { target: { value: string } }) => set({ set: k, value: e.target.value })
  return (
    <div className="builder keypg" data-testid="cross-origin">
      <div className="fields">
        <label>
          Page origin (web/brust.toml)
          <input className="demo-in" value={f.page} onChange={text('page')} />
        </label>
        <label>
          [actions] base_url
          <input className="demo-in" value={f.actions} onChange={text('actions')} />
        </label>
        <label>
          [actions] credentials
          <select className="demo-in" value={f.credentials} onChange={text('credentials')}>
            <option value="same-origin">same-origin</option>
            <option value="include">include</option>
            <option value="omit">omit</option>
          </select>
        </label>
        <label>
          [cors] origins (api/brust.toml)
          <input className="demo-in" value={f.corsOrigins} onChange={text('corsOrigins')} />
        </label>
        <label>
          [actions] cross_site
          <select className="demo-in" value={f.crossSite} onChange={text('crossSite')}>
            <option value="reject">reject</option>
            <option value="allow">allow</option>
          </select>
        </label>
        <label>
          Method
          <select className="demo-in" value={f.method} onChange={text('method')}>
            <option value="POST">POST</option>
            <option value="GET">GET</option>
          </select>
        </label>
        <label className="sw">
          <input type="checkbox" checked={f.corsCredentials} onChange={(e) => set({ set: 'corsCredentials', value: e.target.checked })} />
          <span className="knob" aria-hidden="true" />
          [cors] credentials = true
        </label>
      </div>
      <pre className="cmd" aria-live="polite" data-outcome={r.outcome}>
        <code>{`${r.steps.map((s) => `${s.who.padEnd(7)} ${s.text}`).join('\n')}\n\n=> ${BADGE[r.outcome]}`}</code>
      </pre>
    </div>
  )
}
