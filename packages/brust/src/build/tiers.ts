// F569: `[tiers]` of brust.toml. `[tiers.max]` asserts the heaviest tier a component may compile to; `[tiers] snapshot`
// records every component's tier and fails a build that makes one heavier. Both read the final compile of the app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import type { Compiled } from './compile'
import { BuildError } from './errors'
import { tierOf } from './manifest'
import { relPosix } from './posix'

export type TierName = 'static' | 'native' | 'react'
const RANK: Record<TierName, number> = { static: 0, native: 1, react: 2 }
const TIERS = Object.keys(RANK) as TierName[]

export interface TierRule {
  /** As written in brust.toml (the error names it). */
  pattern: string
  /** The path part, matched with `Bun.Glob` against the app-root-relative `/`-spelled source path. */
  glob: Bun.Glob
  /** The `#Export` part (`default` for the default export); absent = every component of a matching file. */
  export?: string
  /** Characters of the pattern that are not `*` or `?`: the longer pattern wins. */
  weight: number
  max: TierName
}

export interface TiersConfig {
  /** `[tiers] snapshot` as written (app-root relative). */
  snapshot?: string
  max: TierRule[]
}

const TIERS_KEYS = ['snapshot', 'max']

/** `[tiers]` (D1). Absent = no check. */
export function parseTiers(file: string, raw: unknown): TiersConfig | null {
  if (raw === undefined) return null
  const table = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!table(raw)) throw new BuildError('config', `${file}: [tiers] must be a table`)
  for (const k of Object.keys(raw)) if (!TIERS_KEYS.includes(k)) throw new BuildError('config', `${file}: unknown key tiers.${k} (allowed: ${TIERS_KEYS.join(', ')})`)
  let snapshot: string | undefined
  if (raw.snapshot !== undefined) {
    const s = raw.snapshot
    if (typeof s !== 'string' || s.trim() === '' || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\\'))
      throw new BuildError('config', `${file}: tiers.snapshot must be a /-separated path relative to the app root (got ${JSON.stringify(s)})`)
    snapshot = s
  }
  const max: TierRule[] = []
  if (raw.max !== undefined) {
    if (!table(raw.max)) throw new BuildError('config', `${file}: [tiers.max] must be a table of "path pattern" = "static" | "native" | "react"`)
    for (const [pattern, v] of Object.entries(raw.max)) {
      if (typeof v !== 'string') throw new BuildError('config', `${file}: tiers.max."${pattern}" must be a string: "static", "native" or "react" (got ${JSON.stringify(v)})`)
      if (!TIERS.includes(v as TierName)) throw new BuildError('config', `${file}: tiers.max."${pattern}" = ${JSON.stringify(v)} is not a tier (allowed: static, native, react)`)
      max.push(parseRule(file, pattern, v as TierName))
    }
  }
  return { ...(snapshot !== undefined ? { snapshot } : {}), max }
}

function parseRule(file: string, pattern: string, max: TierName): TierRule {
  const bad = (why: string): never => {
    throw new BuildError('config', `${file}: [tiers.max] "${pattern}" is not a valid pattern: ${why}`)
  }
  const at = pattern.indexOf('#')
  const path = at < 0 ? pattern : pattern.slice(0, at)
  const exp = at < 0 ? undefined : pattern.slice(at + 1)
  if (path === '') bad('the path is empty')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) bad('the path must be relative to the app root')
  if (path.includes('\\')) bad('use / to separate directories')
  if (path.startsWith('./')) bad('write the path without ./')
  if (exp !== undefined && !/^[A-Za-z_$][\w$]*$/.test(exp)) bad(`"#${exp}" is not an export name (use #default for the default export)`)
  let glob: Bun.Glob
  try {
    glob = new Bun.Glob(path)
  } catch (e) {
    return bad((e as Error).message)
  }
  return { pattern, glob, ...(exp !== undefined ? { export: exp } : {}), weight: [...path].filter((ch) => ch !== '*' && ch !== '?').length, max }
}

/** A clone or a React copy of a component, made for some call sites: it is checked under its source component. */
function variantOf(c: Compiled): string | undefined {
  const ir = c.ir
  return (ir.react_copy_of ?? ir.fixed_clone_of ?? ir.rest_clone_of ?? (ir.specialised ? '' : undefined)) as string | undefined
}

/** App code only: a package export (an island) and a component compiled from a package's source are the package's. */
function isAppCode(appRoot: string, c: Compiled): boolean {
  if (c.ir.external || c.ir.dist) return false
  const rel = relPosix(appRoot, c.file)
  return !rel.startsWith('.brust/') && !rel.includes('node_modules/')
}

/** `<path>#<Export>` (`#default` for the default export): the key of a component in the snapshot. */
export function tierKey(appRoot: string, c: Compiled): string {
  return `${relPosix(appRoot, c.file)}#${(c.ir.export as string | undefined) ?? 'default'}`
}

/** The rule that decides for a component (D1): one with `#Export` beats one without, then the heavier weight. */
function ruleFor(file: string, rules: TierRule[], path: string, exp: string): TierRule | undefined {
  const hits = rules.filter((r) => (r.export === undefined || r.export === exp) && r.glob.match(path))
  if (hits.length === 0) return undefined
  const score = (r: TierRule) => [r.export !== undefined ? 1 : 0, r.weight] as const
  hits.sort((a, b) => score(b)[0] - score(a)[0] || score(b)[1] - score(a)[1])
  const best = hits[0]!
  const tie = hits.find((r) => r !== best && score(r)[0] === score(best)[0] && score(r)[1] === score(best)[1] && r.max !== best.max)
  if (tie)
    throw new BuildError(
      'config',
      `${file}: [tiers.max] "${best.pattern}" (${best.max}) and "${tie.pattern}" (${tie.max}) both decide ${path}#${exp} with the same weight: make one more specific`,
    )
  return best
}

const CHILD_ONLY = new Set(['external-component', 'child-component']) // tier.rs: fallbacks that concern a child

/** The header position and the cause lines of a component (D3). */
function causes(appRoot: string, c: Compiled, tier: TierName): { at: string; lines: string[] } {
  const file = relPosix(appRoot, c.file)
  if (tier === 'react') {
    const fb = (c.diagnostics ?? []).filter((d) => d.class === 'fallback' && !CHILD_ONLY.has(d.rule))
    if (fb.length > 0)
      return {
        at: `${fb[0]!.file ?? file}:${fb[0]!.line}:${fb[0]!.col}`,
        lines: fb.flatMap((d) => [`  ${d.rule}: ${d.message}`, ...(d.remediation ? [`    fix: ${d.remediation}`] : [])]),
      }
    const t = c.ir.tier as { React?: { reason?: string } }
    return { at: `${file}:1:1`, lines: t.React?.reason ? [`  ${t.React.reason}`] : [] }
  }
  if (tier === 'native') {
    const why = (c.ir.native_because ?? []) as string[]
    const line = why.map((w) => /\(line (\d+)\)$/.exec(w)?.[1]).find((l) => l !== undefined)
    return { at: `${file}:${line ?? 1}:1`, lines: why.map((w) => `  ${w}`) }
  }
  return { at: `${file}:1:1`, lines: [] }
}

/** The component as its author names it: the export, or the file's name for the default export. */
function nameOf(c: Compiled): string {
  return (c.ir.export as string | undefined) ?? basename(c.file, extname(c.file))
}

export interface TierCheck {
  /** One block per violation (D3): the header line, then the cause lines. */
  violations: string[][]
  /** Lines to print whatever happens: a pattern that matches nothing, the snapshot's differences. */
  notes: string[]
  /** The snapshot to write once the build succeeded (never in dev). */
  write?: { path: string; text: string; note: string }
}

/** D2-D5: every app component (variants included) against `[tiers.max]`, the source components against the snapshot. */
export function checkTiers(o: { appRoot: string; file: string; tiers: TiersConfig; compiled: Map<string, Compiled>; dev: boolean; updateTiers: boolean }): TierCheck {
  const { appRoot, tiers } = o
  const out: TierCheck = { violations: [], notes: [] }
  const app = [...o.compiled.values()].filter((c) => isAppCode(appRoot, c))
  // Who places a variant: the component whose children name it (`(the copy made where <id> places it)`).
  const placedBy = new Map<string, string>()
  for (const p of o.compiled.values())
    for (const ref of (p.ir.children ?? []) as { id: string | null }[]) if (ref.id && !placedBy.has(ref.id)) placedBy.set(ref.id, p.id)
  const block = (c: Compiled, tier: TierName, against: string) => {
    const { at, lines } = causes(appRoot, c, tier)
    const variant = variantOf(c) !== undefined
    const where = variant && placedBy.has(c.id) ? ` (the copy made where ${placedBy.get(c.id)} places it)` : ''
    out.violations.push([`${at} ${nameOf(c)}${where} compiles to ${tier}; ${against}`, ...lines])
  }

  // D1/D2: the max rules.
  const used = new Set<TierRule>()
  for (const c of app) {
    const tier = tierOf(c.ir)
    const path = relPosix(appRoot, c.file)
    const exp = (c.ir.export as string | undefined) ?? 'default'
    for (const r of tiers.max) if ((r.export === undefined || r.export === exp) && r.glob.match(path)) used.add(r)
    const rule = ruleFor(o.file, tiers.max, path, exp)
    if (rule && RANK[tier] > RANK[rule.max]) block(c, tier, `[tiers.max] "${rule.pattern}" allows ${rule.max}`)
  }
  for (const r of tiers.max) if (!used.has(r)) out.notes.push(`warning tiers "${r.pattern}" matches no component`)

  // D5: the snapshot, over source components (a component reached only through its variants is recorded by them).
  if (tiers.snapshot === undefined) return out
  const current = new Map<string, { tier: TierName; c: Compiled }>()
  for (const pass of [false, true])
    for (const c of app) {
      if ((variantOf(c) !== undefined) !== pass) continue
      const key = tierKey(appRoot, c)
      if (pass && current.has(key) && variantOf(current.get(key)!.c) === undefined) continue
      const tier = tierOf(c.ir)
      const kept = current.get(key)
      if (!kept || RANK[tier] > RANK[kept.tier]) current.set(key, { tier, c })
    }
  const keys = [...current.keys()].sort()
  const text = `${JSON.stringify({ version: 1, components: Object.fromEntries(keys.map((k) => [k, current.get(k)!.tier])) }, null, 2)}\n`
  const abs = resolve(appRoot, tiers.snapshot)
  if (!existsSync(abs)) {
    if (!o.dev) out.write = { path: abs, text, note: `tiers: wrote ${tiers.snapshot} (${keys.length} components)` }
    return out
  }
  const recorded = readSnapshot(o.file, tiers.snapshot, abs)
  let differs = false
  for (const key of [...new Set([...keys, ...recorded.keys()])].sort()) {
    const now = current.get(key)
    const old = recorded.get(key)
    if (now && old && now.tier === old) continue
    differs = true
    if (now && old && RANK[now.tier] > RANK[old] && !o.updateTiers) {
      block(now.c, now.tier, `${tiers.snapshot} records ${old}`)
      continue
    }
    out.notes.push(`tiers: ${key} ${old ?? 'new'} -> ${now?.tier ?? 'removed'}`)
  }
  if (o.updateTiers && !o.dev && differs) out.write = { path: abs, text, note: `tiers: wrote ${tiers.snapshot} (${keys.length} components)` }
  return out
}

function readSnapshot(file: string, shown: string, abs: string): Map<string, TierName> {
  const bad = (why: string): never => {
    throw new BuildError('config', `${shown} (the [tiers] snapshot of ${file}) ${why}; fix it, or delete it and build to write it again`)
  }
  let json: unknown
  try {
    json = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    return bad(`is not valid JSON: ${(e as Error).message}`)
  }
  const j = json as { version?: unknown; components?: unknown }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return bad('is not a JSON object')
  if (j.version !== 1) bad(`has version ${JSON.stringify(j.version)}; this brust reads version 1`)
  if (j.components === null || typeof j.components !== 'object' || Array.isArray(j.components)) bad('has no "components" object')
  const out = new Map<string, TierName>()
  for (const [k, v] of Object.entries(j.components as Record<string, unknown>)) {
    if (!TIERS.includes(v as TierName)) bad(`records ${JSON.stringify(v)} for ${k}, not static, native or react`)
    out.set(k, v as TierName)
  }
  return out
}

/** Prints the notes; fails the build on a violation (dev prints it as a warning and goes on, D6). */
export function reportTiers(check: TierCheck, dev: boolean, log: (s: string) => void): void {
  for (const n of check.notes) log(n)
  if (check.violations.length === 0) return
  if (dev) {
    for (const [head, ...lines] of check.violations) log([`warning tier ${head}`, ...lines].join('\n'))
    return
  }
  throw new BuildError('tier', check.violations.map((b) => b.join('\n')).join('\n'))
}

/** Writes the snapshot after the build succeeded. */
export function writeTierSnapshot(check: TierCheck, log: (s: string) => void): void {
  if (!check.write) return
  writeFileSync(check.write.path, check.write.text)
  log(check.write.note)
}
