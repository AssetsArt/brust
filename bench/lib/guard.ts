// bench/lib/guard.ts — fairness rules the runner enforces (spec §1.3). `evaluateGuards` is pure;
// `probeHost` collects the inputs. Exit 2 = busy host (retry later), exit 1 = missing tool/declaration.
import { existsSync, readdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join, resolve } from 'node:path'

export interface GuardInput {
  loadavg1: number
  cores: number
  ohaOnPath: boolean
  /** BRUST_RELEASE_ADDON=1: the operator asserts the addon was built with `bun run build`, not build:debug (the runner cannot tell). */
  releaseAddonDeclared: boolean
  addonPresent: boolean
  nodeVersion: string | null
  /** Only the Next.js app runs on Node. */
  needNode: boolean
}
export type GuardVerdict = { ok: true } | { ok: false; code: 1 | 2; reason: string }

export const MIN_NODE_MAJOR = 22
const major = (v: string | null): number => (v ? Number.parseInt(v.replace(/^v/, ''), 10) : Number.NaN)

export function evaluateGuards(i: GuardInput): GuardVerdict {
  if (i.loadavg1 > i.cores) return { ok: false, code: 2, reason: `host busy: load average ${i.loadavg1} > ${i.cores} cores — refusing to measure` }
  if (!i.ohaOnPath) return { ok: false, code: 1, reason: 'oha not on PATH (cargo install oha)' }
  if (!i.addonPresent) return { ok: false, code: 1, reason: 'no addon: cd packages/brust && bun run build (RELEASE)' }
  if (!i.releaseAddonDeclared) return { ok: false, code: 1, reason: 'set BRUST_RELEASE_ADDON=1 to assert the addon was built with `bun run build`, not build:debug' }
  if (i.needNode && !(major(i.nodeVersion) >= MIN_NODE_MAJOR))
    return { ok: false, code: 1, reason: `Next.js runs on Node >= ${MIN_NODE_MAJOR} (found ${i.nodeVersion ?? 'no node on PATH'})` }
  return { ok: true }
}

const ROOT = resolve(import.meta.dir, '../..')
const version = (cmd: string[]): string | null => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  } catch {
    return null
  }
}

export function probeHost(opts: { needNode: boolean; needBrustAddon: boolean }): GuardInput {
  const native = join(ROOT, 'packages/brust/native')
  const addonPresent = !opts.needBrustAddon || (existsSync(native) && readdirSync(native).some((f) => f.endsWith('.node')))
  return {
    loadavg1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
    cores: cpus().length,
    ohaOnPath: version(['oha', '--version']) !== null,
    releaseAddonDeclared: !opts.needBrustAddon || process.env.BRUST_RELEASE_ADDON === '1',
    addonPresent,
    nodeVersion: version(['node', '--version']),
    needNode: opts.needNode,
  }
}
