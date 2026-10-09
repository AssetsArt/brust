// Runs built react island chunks in happy-dom (a separate process: the DOM globals must not leak
// into the rest of `bun test`). argv[2] = JSON [{ chunk, id, html, props? }]; prints
// { errors, islands: [{ html, sameNode }] } — `sameNode`: the host's first child survived (hydrated
// in place rather than re-created).
import { join } from 'node:path'

// happy-dom is a dev dependency of the sibling workspace package (runtime-dom).
const { GlobalRegistrator } = await import(
  Bun.resolveSync('@happy-dom/global-registrator', join(import.meta.dir, '../../../runtime-dom'))
)
GlobalRegistrator.register()

const errors: string[] = []
const record = (...a: unknown[]) => errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '))
console.error = record
console.warn = record
;(globalThis as { reportError?: unknown }).reportError = record
window.addEventListener('error', (e) => record((e as ErrorEvent).message))

type Spec = { chunk: string; id: string; html: string; props?: Record<string, unknown> }
const specs = JSON.parse(process.argv[2]!) as Spec[]
const hosts = specs.map((s) => {
  const host = document.createElement('brust-island')
  host.setAttribute('data-id', s.id)
  host.innerHTML = s.html
  document.body.appendChild(host)
  return { host, first: host.firstChild }
})
for (const s of specs) await import(s.chunk)
const islands = (globalThis as { __brustIslands?: [string, (h: Element, p: unknown) => void][] }).__brustIslands ?? []
specs.forEach((s, i) => {
  const fn = islands.find(([id]) => id === s.id)?.[1]
  if (!fn) throw new Error(`island ${s.id} did not register`)
  fn(hosts[i]!.host, s.props ?? {})
})
await new Promise((r) => setTimeout(r, 100))
process.stdout.write(
  JSON.stringify({
    errors,
    islands: hosts.map(({ host, first }) => ({ html: host.innerHTML, sameNode: first !== null && host.firstChild === first })),
  }),
)
process.exit(0)
