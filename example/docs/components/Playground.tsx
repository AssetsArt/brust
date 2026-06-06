// NATIVE INTERACTIVE COMPONENT — a live JSON-API playground. Type a message, click
// Run, and it fires the typed treaty client at POST /_brust/action/echo (a real
// brust action that is ALSO an MCP tool) and renders the `{ data, error, status }`
// round-trip. react-free: `client` from brustjs/client is the treaty proxy (no
// react), same as pokedex ThemeToggle. Single-file behavior → "playground" chunk.
import { client } from 'brustjs/client'
import { signal } from 'brustjs/store'
import type { actions } from '../actions'

const api = client<typeof actions>()

export const behavior = () => {
  const message = signal('hello from the docs')
  const result = signal('// click Run to call POST /_brust/action/echo')
  const onInput = (e: Event) => message.set((e.target as HTMLInputElement).value)
  const run = async () => {
    result.set('…')
    const res = await api.echo.post({ message: message() })
    result.set(JSON.stringify({ data: res.data, error: res.error, status: res.status }, null, 2))
  }
  return { message, result, onInput, run }
}

// Co-located source for the <Example> "Source" pane (kept here, not in a page, so the
// directive text-scan for `export const behavior` doesn't false-positive — gap G5).
export const source =
  "import { client } from 'brustjs/client'\nimport { signal } from 'brustjs/store'\nimport type { actions } from '../actions'\n\nconst api = client<typeof actions>()\n\nexport const behavior = () => {\n  const message = signal('hello from the docs')\n  const result = signal('// click Run')\n  const onInput = (e) => message.set(e.target.value)\n  const run = async () => {\n    result.set('…')\n    const res = await api.echo.post({ message: message() })\n    result.set(JSON.stringify({ data: res.data, error: res.error, status: res.status }, null, 2))\n  }\n  return { message, result, onInput, run }\n}"

export default function Playground() {
  return (
    <div className="not-prose flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          type="text"
          x-on-input="onInput"
          aria-label="Message to echo"
          value="hello from the docs"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="button"
          x-on-click="run"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-600"
        >
          Run ▸
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-sm leading-relaxed text-emerald-300">
        <code x-text="result">{'// click Run to call POST /_brust/action/echo'}</code>
      </pre>
    </div>
  )
}
