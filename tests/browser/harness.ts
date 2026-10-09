// Browser harness (spec §12): compiles a fixture with the real `brustc`, runs
// its precompute job, renders the jinja with `brustc --render`, loads the HTML
// into a DOM, imports the generated chunks and mounts packages/runtime-dom.
// The only logic here is plumbing; cases assert behaviour.
//
// DOM: happy-dom (Playwright is not a dependency of this repo). The cases do NOT
// run unchanged in Chromium: the chunks are emitted with `--runtime-import`
// pointing at a `.ts` path and fixtures import `./money` without an extension,
// so a browser run would first need a bundling step (e.g. `Bun.build`) over the
// chunks and the fixture modules.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const repo = resolve(import.meta.dir, '../..')
const runtimeSrc = join(repo, 'packages/runtime-dom/src/index.ts')
const evalTs = join(repo, 'crates/brust-compiler/tests/harness/eval.ts')

const { GlobalRegistrator } = await import(Bun.resolveSync('@happy-dom/global-registrator', join(repo, 'packages/runtime-dom')))
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register()

const runtime = await import(runtimeSrc)
const { instanceOf } = await import(join(repo, 'packages/runtime-dom/src/instance.ts'))
const { __resetWarnOnce } = await import(join(repo, 'packages/runtime-dom/src/warn.ts'))
const runtimeUnmount = (runtime as { unmount: () => void }).unmount
export const { mount } = runtime as { mount: () => void }
export { instanceOf }

// console capture lives from before the chunk import until `unmount()`, so warnings
// raised by interactions and observer-driven mounts are seen too.
const consoleWarn = console.warn
const consoleError = console.error
let capture: string[] | null = null
/** Restores the console, forgets `warnOnce` keys and unmounts the runtime. */
export function unmount(): void {
  console.warn = consoleWarn
  console.error = consoleError
  capture = null
  __resetWarnOnce()
  runtimeUnmount()
}

export const DOM_ENGINE = 'happy-dom'

function sh(cmd: string, args: string[], cwd = repo): string {
  const p = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (p.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${p.stdout}${p.stderr}`)
  return p.stdout
}

const brustc = join(process.env.CARGO_TARGET_DIR ?? join(repo, 'target'), 'debug/brustc')
let built = false
function ensureBrustc() {
  if (built) return
  sh('cargo', ['build', '-q', '-p', 'brust-compiler-cli'])
  built = true
}

export interface Built { name: string; dir: string; html: string; chunks: string[]; rootId: string }

/** Artifacts + server-rendered HTML for fixture `name` with a sample props file. */
export function build(name: string, sample = 'sample-props.json'): Built {
  ensureBrustc()
  const dir = mkdtempSync(join(tmpdir(), `brust-browser-${name}-`))
  const input = `tests/fixtures/${name}/input.tsx`
  const listed = sh(brustc, [input, '--emit', 'all', '--out', dir, '--runtime-import', runtimeSrc]).trim().split('\n')
  const rootId = listed[0]!.split('/').pop()!.replace(/\..*$/, '')
  // The modules the fixture imports (`money.ts`) sit next to the generated files.
  for (const f of readdirSync(join(repo, 'tests/fixtures', name))) {
    if (f.endsWith('.ts') && !f.startsWith('expected.')) copyFileSync(join(repo, 'tests/fixtures', name, f), join(dir, f))
  }
  const props = join(repo, 'tests/fixtures', name, sample)
  const job = join(dir, `${rootId}.server.ts`)
  const slotsFile = join(dir, 'slots.json')
  // The compiler decides: the root has a job iff it emitted `<root>.server.ts`.
  const hasJob = readdirSync(dir).includes(`${rootId}.server.ts`)
  writeFileSync(slotsFile, hasJob ? sh('bun', [evalTs, 'slots', job, props]) : '{}')
  const html = sh(brustc, [input, '--render', props, '--slots', slotsFile])
  const chunks = readdirSync(dir).filter((f) => f.endsWith('.client.js')).map((f) => join(dir, f))
  return { name, dir, html, chunks, rootId }
}

/** The DOM minus directive bookkeeping: comments, `x-*` attributes and the hidden x-if/x-for templates. */
export function visible(root: ParentNode = document.body): string {
  const c = (root as Element).cloneNode(true) as Element
  const walk = (n: Node) => {
    for (const k of Array.from(n.childNodes)) {
      if (k.nodeType === 8) (k as ChildNode).remove()
      else if (k.nodeType === 1 && (k as Element).hasAttribute('hidden') && ((k as Element).hasAttribute('x-if') || (k as Element).hasAttribute('x-for'))) (k as Element).remove()
      else if (k.nodeType === 1) {
        for (const a of Array.from((k as Element).attributes)) if (a.name.startsWith('x-')) (k as Element).removeAttribute(a.name)
        walk(k)
      }
    }
  }
  walk(c)
  return c.innerHTML
}

export interface Mounted extends Built { warnings: string[]; before: string; after: string }

/** Loads `html` into the page, imports the chunks and mounts. `warnings` is live: it keeps collecting `console.warn` / `console.error` until `unmount()`. */
export async function load(b: Built): Promise<Mounted> {
  unmount()
  document.body.innerHTML = b.html
  const before = visible()
  const warnings: string[] = []
  capture = warnings
  console.warn = (...a: unknown[]) => { capture?.push('warn: ' + a.map(String).join(' ')) }
  console.error = (...a: unknown[]) => { capture?.push('error: ' + a.map(String).join(' ')) }
  for (const c of b.chunks) await import(`${c}?v=${Math.random()}`)   // fresh module per case: defineBehavior re-registers
  mount()
  // happy-dom queues MutationObserver callbacks with queueMicrotask: let observer-driven mounts run.
  await new Promise<void>((r) => queueMicrotask(r))
  await new Promise<void>((r) => queueMicrotask(r))
  return { ...b, warnings, before, after: visible() }
}

export const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as E
export const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as E[]
export const text = (sel: string, root: ParentNode = document) => $(sel, root)?.textContent ?? null
export function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
export function members(host: Element): Record<string, any> {
  return instanceOf(host)?.members ?? {}
}
