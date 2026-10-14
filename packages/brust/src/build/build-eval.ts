// Build-time evaluation of precompute slots (L2, G4/H1). The compiler marks the slots that read
// nothing request- or time-dependent (`ir.build_eval`) and emits one thunk per slot (`evalTs`).
// Here they are bundled once, run in a Bun subprocess (`TZ=UTC`, a timeout per slot, JSON-only
// values, a size cap) and the results go back to the compiler as slot -> literal overrides: the
// slot, and a job left with no slots, disappear. A pure helper that fails keeps its job with a
// `build-eval` warning; a failing `buildTime(…)` is a build error (the user asked for it).
//
// F149 (R34.90): an inlined instance whose child job reads only constants and allowed code
// (`ir.build_eval_instances`) runs that child's job module, the file the worker loads, once per distinct
// input in the same sandbox; its relative imports the compiler re-emitted folded (`stubs`) are served from
// that code. The outputs go back as `<instance key>#<slot>` values: the instance and its record disappear.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { BunPlugin } from 'bun'
import { type SourceOf, PRODUCTION, sourceDirPlugin, stage, write } from './bundle'
import type { Compiled } from './compile'
import { BuildError } from './errors'

const V1 = { timeoutMs: 2_000, capBytes: 64 * 1024 }
const BUILD_TIME = { timeoutMs: 10_000, capBytes: 256 * 1024 }

interface Candidate {
  key: string
  bt: boolean
  where: string
}

/** The runner the subprocess executes: loads the bundle, guards the sources of nondeterminism,
 * and prints `S <i>` before and `R <i> <json>` / `E <i> <message>` after each slot. */
const RUNNER = `
const mod = await import(process.argv[2])
const start = Number(process.argv[3])
const slots = mod.default
const deny = (what) => () => { throw new Error('build-eval: ' + what + ' is not allowed (it differs between runs)') }
const RealDate = globalThis.Date
globalThis.Date = new Proxy(RealDate, {
  construct(t, a) { if (a.length === 0) deny('new Date()')(); return Reflect.construct(t, a) },
  apply() { deny('Date()')() },
  get(t, p, r) { if (p === 'now') deny('Date.now()')(); return Reflect.get(t, p, r) },
})
Math.random = deny('Math.random()')
if (globalThis.performance) globalThis.performance.now = deny('performance.now()')
if (globalThis.crypto) { for (const k of ['randomUUID', 'getRandomValues']) { try { globalThis.crypto[k] = deny('crypto.' + k + '()') } catch {} } }
globalThis.fetch = deny('fetch()')
const out = (l) => process.stdout.write(l + '\\n')
const env = process.env
try { Object.defineProperty(process, 'env', { configurable: true, get: deny('process.env') }) } catch {}
const enc = (v, path) => {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('not JSON: ' + path + ' is ' + v); return v }
  if (Array.isArray(v)) return v.map((x, i) => { if (x === undefined && !(i in v)) throw new Error('not JSON: sparse array at ' + path); return enc(x, path + '[' + i + ']') })
  if (typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    return { $: Object.keys(v).map((k) => { if (v[k] === undefined) throw new Error('not JSON: ' + path + '.' + k + ' is undefined'); return [k, enc(v[k], path + '.' + k)] }) }
  }
  throw new Error('not JSON: ' + path + ' is ' + (v === undefined ? 'undefined' : typeof v === 'object' ? (v.constructor && v.constructor.name) : typeof v))
}
for (let i = start; i < slots.length; i++) {
  out('S ' + i)
  try {
    const v = await slots[i].fn()
    out('R ' + i + ' ' + JSON.stringify(enc(v, 'value')))
  } catch (e) {
    out('E ' + i + ' ' + String(e && e.message ? e.message : e).split('\\n')[0])
  }
}
`

/** The evaluator sees an explicit allowlist, never the build host's environment: `process.env`,
 * `Bun.env` and `import.meta.env` all read from it, however they are spelled. */
function evalEnv(): Record<string, string> {
  const env: Record<string, string> = { TZ: 'UTC', NODE_ENV: 'production' }
  for (const k of ['PATH', 'HOME']) if (process.env[k] !== undefined) env[k] = process.env[k]!
  return env
}

type Outcome = { ok: true; value: unknown } | { ok: false; reason: string }

/** Runs slots `[0, n)` of `entry` one after the other, restarting the subprocess after a timeout or crash. */
async function runAll(entry: string, runner: string, cands: Candidate[], cwd: string): Promise<Outcome[]> {
  const out: (Outcome | undefined)[] = new Array(cands.length).fill(undefined)
  let next = 0
  while (next < cands.length) {
    const proc = Bun.spawn([process.execPath, runner, entry, String(next)], { cwd, env: evalEnv(), stdout: 'pipe', stderr: 'pipe' })
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ''
    let current = -1
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const arm = (i: number) => {
      clearTimeout(timer)
      const limit = cands[i]!.bt ? BUILD_TIME.timeoutMs : V1.timeoutMs
      timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGKILL')
      }, limit)
    }
    const line = (l: string) => {
      const m = /^([SRE]) (\d+)(?: (.*))?$/.exec(l)
      if (!m) return
      const i = Number(m[2])
      if (m[1] === 'S') {
        current = i
        arm(i)
        return
      }
      clearTimeout(timer)
      const cap = cands[i]!.bt ? BUILD_TIME.capBytes : V1.capBytes
      if (m[1] === 'E') out[i] = { ok: false, reason: m[3] ?? 'threw' }
      else if ((m[3] ?? '').length > cap) out[i] = { ok: false, reason: `value is larger than ${cap / 1024} KiB` }
      else out[i] = { ok: true, value: JSON.parse(m[3]!) }
      next = i + 1
      current = -1
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    clearTimeout(timer)
    await proc.exited
    if (current >= 0) {
      const limit = (cands[current]!.bt ? BUILD_TIME.timeoutMs : V1.timeoutMs) / 1000
      const stderr = (await new Response(proc.stderr as ReadableStream).text()).trim().split('\n')[0]
      out[current] = { ok: false, reason: timedOut ? `timed out after ${limit} s` : `the evaluator exited${stderr ? `: ${stderr}` : ''}` }
      next = current + 1
    } else if (next < cands.length && !out[next]) {
      // Exited before reporting anything (the bundle failed to load).
      const stderr = (await new Response(proc.stderr as ReadableStream).text()).trim().split('\n').slice(0, 3).join(' | ')
      for (let i = next; i < cands.length; i++) out[i] = { ok: false, reason: `the evaluator could not start${stderr ? `: ${stderr}` : ''}` }
      next = cands.length
    }
  }
  return out as Outcome[]
}

/** `@brust/core` inside the evaluator is the side-effect-free `buildTime` module, not the server. */
function corePlugin(appRoot: string): BunPlugin {
  return {
    name: 'brust-eval-core',
    setup(b) {
      b.onResolve({ filter: /^@brust\/core$/ }, () => ({ path: Bun.resolveSync('@brust/core/build-time', appRoot) }))
    },
  }
}

/** Evaluates every build-time slot and every build-evaluated instance of `compiled`; returns `key -> encoded
 * JSON value` for those that succeeded. Throws a `BuildError` for a failing `buildTime(…)`; logs
 * `warning build-eval` for a pure helper or an instance that fails (its job stays). */
export async function evaluateBuildSlots(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceOf: SourceOf,
  appRoot: string,
  log: (s: string) => void,
): Promise<Record<string, unknown>> {
  // `BRUST_BUILD_EVAL=0` turns evaluation off (every slot and instance stays a job): the reference for dual runs.
  if (process.env.BRUST_BUILD_EVAL === '0') return {}
  const slots = await evaluateSlots(dist, compiled, sourceOf, appRoot, log)
  const instances = await evaluateInstances(dist, compiled, sourceOf, appRoot, log)
  return { ...slots, ...instances }
}

/** L2: the slots of `ir.build_eval`. */
async function evaluateSlots(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceOf: SourceOf,
  appRoot: string,
  log: (s: string) => void,
): Promise<Record<string, unknown>> {
  const cands: Candidate[] = []
  const imports: string[] = []
  const entries: string[] = []
  for (const c of compiled.values()) {
    const slots = (c.ir.build_eval ?? []) as { key: string; build_time: boolean; line: number; col: number }[]
    if (c.evalTs === undefined || slots.length === 0) continue
    const file = join(dist, '.stage', 'eval', `${c.id}.eval.ts`)
    write(file, c.evalTs)
    stage(sourceOf, file, c)
    const n = imports.length
    imports.push(`import { slots as s${n} } from ${JSON.stringify(file)}`)
    for (const s of slots) {
      const where = `${c.file.slice(appRoot.length + 1)}:${s.line}:${s.col}`
      cands.push({ key: s.key, bt: s.build_time, where })
      entries.push(`  { fn: s${n}[${JSON.stringify(s.key)}] },`)
    }
  }
  if (cands.length === 0) return {}
  const entry = join(dist, '.stage', 'eval-entry.ts')
  write(entry, `${imports.join('\n')}\nexport default [\n${entries.join('\n')}\n]\n`)
  const res = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    define: PRODUCTION,
    plugins: [corePlugin(appRoot), sourceDirPlugin(sourceOf, appRoot)],
  })
  if (!res.success) throw new BuildError('build-eval', `cannot bundle the build-time evaluation: ${res.logs.map(String).join('\n')}`)
  const bundle = join(dist, '.stage', 'eval.js')
  write(bundle, await res.outputs[0]!.text())
  const runner = join(dist, '.stage', 'eval-run.js')
  write(runner, RUNNER)
  const results = await runAll(bundle, runner, cands, appRoot)
  const values: Record<string, unknown> = {}
  results.forEach((r, i) => {
    const c = cands[i]!
    if (r.ok) values[c.key] = r.value
    else if (c.bt) throw new BuildError('build-time', `${c.where} buildTime(…) failed at build: ${r.reason}`)
    else log(`warning build-eval ${c.where} not evaluated at build, the job stays: ${r.reason}`)
  })
  return values
}

type EvalInstance = NonNullable<Compiled['ir']['build_eval_instances']>[number]

/** Serves a relative import of a staged job module from the stub the compiler printed for it (rule 3). */
function stubPlugin(stubs: Map<string, Map<string, string>>): BunPlugin {
  return {
    name: 'brust-eval-stub',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (a) => {
        const file = stubs.get(a.importer)?.get(a.path)
        return file === undefined ? undefined : { path: file }
      })
    },
  }
}

/** F149 (R34.90): runs each distinct `(child, inputs)` of `ir.build_eval_instances` through the child's own job
 * module (`serverTs`, what the worker loads) once; returns `<key>#<slot> -> encoded value` for every instance
 * whose evaluation succeeded with all of its outputs. A failure is a warning and the instance keeps its job. */
async function evaluateInstances(
  dist: string,
  compiled: Map<string, Compiled>,
  sourceOf: SourceOf,
  appRoot: string,
  log: (s: string) => void,
): Promise<Record<string, unknown>> {
  const groups = new Map<string, { inst: EvalInstance; where: string; keys: string[] }>()
  const modules = new Map<string, string>()
  const stubs = new Map<string, Map<string, string>>()
  const imports: string[] = []
  for (const c of compiled.values()) {
    for (const inst of c.ir.build_eval_instances ?? []) {
      const child = compiled.get(inst.child_id)
      if (child?.serverTs === undefined) continue
      if (!modules.has(child.id)) {
        const file = join(dist, '.stage', 'eval', `${child.id}.job.ts`)
        write(file, child.serverTs)
        stage(sourceOf, file, child)
        const served = new Map<string, string>()
        for (const [i, st] of (inst.stubs ?? []).entries()) {
          const stub = join(dist, '.stage', 'eval', 'stubs', child.id, `${i}.ts`)
          write(stub, st.code)
          stage(sourceOf, stub, child)
          served.set(st.source, stub)
        }
        if (served.size > 0) {
          stubs.set(file, served)
          stubs.set(realpathSync(file), served)
        }
        modules.set(child.id, `j${modules.size}`)
        imports.push(`import { precompute as ${modules.get(child.id)} } from ${JSON.stringify(file)}`)
      }
      const id = `${inst.child_id}\0${JSON.stringify(inst.inputs)}`
      const where = `${c.file.slice(appRoot.length + 1)}:${inst.line}:${inst.col}`
      const g = groups.get(id)
      if (g) g.keys.push(inst.key)
      else groups.set(id, { inst, where, keys: [inst.key] })
    }
  }
  if (groups.size === 0) return {}
  const list = [...groups.values()]
  const entry = join(dist, '.stage', 'eval-instances-entry.ts')
  write(entry, `${imports.join('\n')}\nexport default [\n${list.map((g) => `  { fn: () => ${modules.get(g.inst.child_id)}(${JSON.stringify(g.inst.inputs)}) },`).join('\n')}\n]\n`)
  const res = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    define: PRODUCTION,
    plugins: [stubPlugin(stubs), sourceDirPlugin(sourceOf, appRoot)],
  })
  if (!res.success) {
    log(`warning build-eval the instance jobs could not be bundled for build evaluation, they stay per-request jobs: ${res.logs.map(String).join(' | ').split('\n')[0]}`)
    return {}
  }
  const bundle = join(dist, '.stage', 'eval-instances.js')
  write(bundle, await res.outputs[0]!.text())
  const runner = join(dist, '.stage', 'eval-run.js')
  write(runner, RUNNER)
  const results = await runAll(bundle, runner, list.map((g) => ({ key: g.inst.key, bt: false, where: g.where })), appRoot)
  const values: Record<string, unknown> = {}
  results.forEach((r, i) => {
    const g = list[i]!
    const pairs = r.ok ? outputsOf(r.value) : undefined
    const missing = pairs && g.inst.outputs.find((o) => !pairs.has(o))
    if (!r.ok || !pairs || missing !== undefined) {
      const reason = !r.ok ? r.reason : !pairs ? 'the job did not return an object' : `the job did not return \`${missing}\``
      log(`warning build-eval ${g.where} <${g.inst.child_id}> not evaluated at build, its job stays: ${reason}`)
      return
    }
    for (const key of g.keys) for (const o of g.inst.outputs) values[`${key}#${o}`] = pairs.get(o)
  })
  return values
}

/** The slots of an encoded job result (`{ $: [[slot, value], …] }`, see the runner's `enc`). */
function outputsOf(v: unknown): Map<string, unknown> | undefined {
  const pairs = (v as { $?: unknown } | null)?.$
  if (!Array.isArray(pairs)) return undefined
  return new Map(pairs.map((p) => [String((p as unknown[])[0]), (p as unknown[])[1]]))
}
