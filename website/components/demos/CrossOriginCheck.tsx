// Demo (client-only): a page on one origin calling actions on another. Set both deployments' settings and see, step by
// step, what the browser and the actions server do: the preflight, the credentials rule, the cross-site guard. The
// rules are components/demos/cross-origin.ts, evaluated in your browser; nothing is sent.
import { useReducer, useTransition } from 'react'
import { type CrossOriginInput, checkCrossOrigin } from './cross-origin'

type Action = { set: keyof CrossOriginInput; value: string | boolean }

// One reducer holds the form. (useTransition, a hook the native tier does not compile, keeps this a React island: the
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
  useTransition() // keeps this a React island: the native tier does not compile it
  const [f, set] = useReducer(reduce, START)
  const r = checkCrossOrigin(f)
  const text = (k: keyof CrossOriginInput) => (e: { target: { value: string } }) => set({ set: k, value: e.target.value })
  return (
    <div className="grid min-w-0 gap-3" data-testid="cross-origin">
      <div className="grid grid-cols-[minmax(0,1fr)] items-end gap-x-4 gap-y-3">
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Page origin (web/brust.toml)
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.page} onChange={text('page')} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          [actions] base_url
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.actions} onChange={text('actions')} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          [actions] credentials
          <select className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.credentials} onChange={text('credentials')}>
            <option value="same-origin">same-origin</option>
            <option value="include">include</option>
            <option value="omit">omit</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          [cors] origins (api/brust.toml)
          <input className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.corsOrigins} onChange={text('corsOrigins')} />
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          [actions] cross_site
          <select className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.crossSite} onChange={text('crossSite')}>
            <option value="reject">reject</option>
            <option value="allow">allow</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-[.3rem] font-mono text-[12px] text-ink-2">
          Method
          <select className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font-weight:inherit] [line-height:inherit] font-mono text-[13.5px]" value={f.method} onChange={text('method')}>
            <option value="POST">POST</option>
            <option value="GET">GET</option>
          </select>
        </label>
        <label className="inline-flex min-w-0 cursor-pointer items-center gap-[.3rem] font-text text-[14.5px] text-ink select-none">
          <input type="checkbox" className="peer absolute h-px w-px opacity-0" checked={f.corsCredentials} onChange={(e) => set({ set: 'corsCredentials', value: e.target.checked })} />
          <span className="relative h-5 w-[2.2rem] flex-none rounded-full bg-rule peer-checked:bg-amber-fill peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-amber motion-safe:transition-[background-color] motion-safe:duration-200 after:absolute after:top-[2px] after:left-[2px] after:size-[calc(1.25rem-4px)] after:rounded-full after:bg-sheet after:shadow-[0_1px_2px_rgba(0,0,0,.25)] after:content-[''] peer-checked:after:translate-x-[.95rem] motion-safe:after:transition-transform motion-safe:after:duration-200 motion-safe:after:ease-[cubic-bezier(.2,.7,.2,1)]" aria-hidden="true" />
          [cors] credentials = true
        </label>
      </div>
      {/* the steps are sentences: wrap them instead of scrolling sideways */}
      <pre className="cmd m-0 mt-3 overflow-x-auto rounded-xs border border-term-rule bg-term px-4 py-[.8rem] text-[13px] leading-[1.6] text-term-fg whitespace-pre-wrap wrap-anywhere" aria-live="polite" data-outcome={r.outcome}>
        <code>{`${r.steps.map((s) => `${s.who.padEnd(7)} ${s.text}`).join('\n')}\n\n=> ${BADGE[r.outcome]}`}</code>
      </pre>
    </div>
  )
}
