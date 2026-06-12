// Generator-tag decision module. ONE resolved decision { meta, header } made at
// build time (brust build / brust dev write generator.json into every jinja out
// dir); consumed by the jinja emitters (bake), the React stream injector, and
// the X-Powered-By napi thread. The name "brust" is mandatory; only the version
// substring is optional (--no-generator-version). Spec:
// docs/superpowers/specs/2026-06-12-generator-tag-design.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readVersion } from './cli/help.ts'

export interface GeneratorStrings {
  /** Full meta tag, e.g. `<meta name="generator" content="brust 0.1.48-alpha"/>` */
  meta: string
  /** X-Powered-By value, e.g. `brust/0.1.48-alpha` */
  header: string
}

/** Build the resolved strings. Version comes from the brustjs package.json
 * (readVersion never throws — "unknown" degrades to name-only, never a crash).
 * The version is sanitized to attr/header-safe bytes; semver chars only. */
export function generatorStrings(versionOn: boolean): GeneratorStrings {
  const raw = readVersion()
  const v = raw === 'unknown' ? '' : raw.replace(/[^0-9A-Za-z.+-]/g, '')
  const withVersion = versionOn && v.length > 0
  return {
    meta: `<meta name="generator" content="brust${withVersion ? ` ${v}` : ''}"/>`,
    header: withVersion ? `brust/${v}` : 'brust',
  }
}

/** The exact head literal the Rust compiler emits for every Document template
 * (crates/jsx-rust-compiler/src/emit_jinja.rs:110). Compiler-owned and stable. */
const VIEWPORT_ANCHOR = '<meta name="viewport" content="width=device-width, initial-scale=1"/>'

/** Insert the generator meta immediately after the compiler-emitted viewport
 * meta. Anchor missing (non-document template) → no-op, never an error.
 * CALLER CONTRACT: pass fresh compiler output — this function does not check
 * for an existing tag, so calling it twice on the same string duplicates.
 * Every emit path recompiles from source each run, which keeps this safe. */
export function insertGeneratorMeta(jinja: string, metaTag: string): string {
  const at = jinja.indexOf(VIEWPORT_ANCHOR)
  if (at === -1) return jinja
  const end = at + VIEWPORT_ANCHOR.length
  return jinja.slice(0, end) + metaTag + jinja.slice(end)
}

/** Write the decision artifact into `dir` (a jinja out dir), creating it. */
export function writeGeneratorArtifact(dir: string, strings: GeneratorStrings): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'generator.json'), JSON.stringify(strings))
}

/** Read the artifact; null on missing/malformed (caller decides the fallback). */
export function readGeneratorArtifact(dir: string): GeneratorStrings | null {
  try {
    const raw = readFileSync(path.join(dir, 'generator.json'), 'utf8')
    // unknown + explicit narrowing (not a cast): a JSON `null`/non-object body
    // must reach the `return null` below by DESIGN, not by riding the catch.
    const p: unknown = JSON.parse(raw)
    if (typeof p === 'object' && p !== null) {
      const { meta, header } = p as Record<string, unknown>
      if (typeof meta === 'string' && typeof header === 'string') {
        return { meta, header }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Artifact if present, else version-on defaults — the spec's fallback policy
 * (an old dist with no artifact behaves as default = version on). */
export function resolveGenerator(dir: string): GeneratorStrings {
  return readGeneratorArtifact(dir) ?? generatorStrings(true)
}
