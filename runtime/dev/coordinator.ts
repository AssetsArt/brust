import type { DevMessage } from './ws-channel.ts'
import type { ChangeKind } from './watcher.ts'

export interface CoordinatorDeps {
  workers: {
    terminateAll(): Promise<void>
    spawnAll(): Promise<void>
  }
  buildCss: () => Promise<void>
  buildIslands: () => Promise<void>
  /** Parse changed JS/TS modules before mutating the live generation. */
  validateChanges: (paths: string[]) => Promise<void>
  /** Recompile native-route `.jinja` templates from source and reload them into
   * the minijinja env, so `native: true` routes pick up .tsx edits on reload. */
  reEmitJinja: () => Promise<void>
  /** Clear the Rust-side island ISR cache. Called on every render-affecting
   * reload (`ts`/`html`/`islands`) so a `.tsx` edit is reflected immediately —
   * a frozen island render from before the edit must never survive a hot reload.
   * Optional: a build without the island-cache addon export omits it. */
  clearIslandCache?: () => void
  buildComponentCss?: () => Promise<void>
  snapshotComponentCss?: () => Promise<import('../css/manifest.ts').ComponentCssManifest | null>
  broadcast: (msg: DevMessage) => Promise<void> | void
  tui: { appendEvent(line: string): void }
}

type BuildDomain = 'full' | 'app-css' | 'component-css'

interface PendingBatch {
  kind: ChangeKind
  paths: Set<string>
}

const DOMAIN_PRIORITY: BuildDomain[] = ['full', 'app-css', 'component-css']

export class Coordinator {
  private readonly pending = new Map<BuildDomain, PendingBatch>()
  private drainPromise: Promise<void> | null = null

  constructor(private deps: CoordinatorDeps) {}

  handleChange(ev: { paths: string[]; kind: ChangeKind }): Promise<void> {
    const domain = domainFor(ev.kind)
    const existing = this.pending.get(domain)
    if (existing) {
      for (const path of ev.paths) existing.paths.add(path)
    } else {
      this.pending.set(domain, { kind: ev.kind, paths: new Set(ev.paths) })
    }

    if (!this.drainPromise) {
      // Defer ownership by one microtask so the watcher's ordered callbacks for
      // a mixed debounce window can coalesce into the three bounded domains.
      this.drainPromise = Promise.resolve()
        .then(() => this.drainPending())
        .finally(() => {
          this.drainPromise = null
        })
    }
    return this.drainPromise
  }

  private async drainPending(): Promise<void> {
    while (true) {
      const event = this.takeNext()
      if (!event) return
      await this.runBatch(event)
    }
  }

  private takeNext(): { paths: string[]; kind: ChangeKind } | null {
    for (const domain of DOMAIN_PRIORITY) {
      const batch = this.pending.get(domain)
      if (!batch) continue
      this.pending.delete(domain)
      return { kind: batch.kind, paths: Array.from(batch.paths) }
    }
    return null
  }

  private async runBatch(ev: { paths: string[]; kind: ChangeKind }): Promise<void> {
    const started = performance.now()
    try {
      await this.deps.broadcast({ type: 'building' })
      this.deps.tui.appendEvent(formatStart(ev))
      switch (ev.kind) {
        case 'ts':
        case 'html':
        case 'islands':
        // 'md' (task 2.9) takes the SAME full path as a .tsx edit: buildIslands
        // (wired in index.ts) re-runs emitMdArtifacts — the md re-splice — and
        // the worker restart is REQUIRED because loadIslandManifest caches
        // per-isolate (islands/native-render.ts), so a re-emitted
        // .islands.json sidecar is never re-read by a live worker.
        case 'md':
          await this.deps.validateChanges(ev.paths)
          // Stale frozen island renders must not survive a source edit.
          this.deps.clearIslandCache?.()
          // Rebuild island CLIENT chunks. The watcher classifies every `.tsx`
          // (incl. an island's client source) as `ts` — it has no way to tell
          // an island source from a page/component by path alone, and the
          // island set changes as you add/remove `<Island>` usages. So we
          // rebuild island chunks on every render-affecting reload; otherwise
          // editing an island's JS never reaches the browser without a
          // dev-server restart (the chunk on disk stays stale). buildIslands
          // re-scans routes + re-bundles into the served `.brust/islands` dir.
          await this.deps.buildIslands()
          // Reload native-route templates BEFORE restarting the workers:
          // napiLoadJinjaTemplates operates on the PROCESS-GLOBAL Rust
          // minijinja env (it does not depend on the workers), so reloading
          // first closes the stale-serve window where freshly spawned workers
          // answer requests against the OLD jinja. The browser reload is
          // broadcast last, after the new workers are up.
          await this.deps.reEmitJinja()
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          await this.deps.broadcast({ type: 'reload' })
          break
        case 'css':
          await this.deps.buildCss()
          await this.deps.broadcast({
            type: 'css-update',
            href: '/_brust/css/app.css?v=' + Date.now(),
          })
          break
        case 'component-css': {
          const before = await this.deps.snapshotComponentCss?.()
          await this.deps.buildComponentCss?.()
          const after = await this.deps.snapshotComponentCss?.()
          if (!exportsEqualForChanged(before ?? null, after ?? null, ev.paths)) {
            await this.deps.broadcast({ type: 'reload' })
          } else {
            const chunks = chunksForPaths(after ?? null, ev.paths)
            for (const c of chunks) {
              await this.deps.broadcast({
                type: 'css-update',
                href: `${c}?v=${Date.now()}`,
              })
            }
          }
          break
        }
      }
      const ms = (performance.now() - started) | 0
      this.deps.tui.appendEvent(`  → ok (${ms}ms)`)
      await this.deps.broadcast({ type: 'ok' })
    } catch (e: any) {
      this.deps.tui.appendEvent(`  ✗ ${e.message ?? String(e)}`)
      await this.deps.broadcast({
        type: 'error',
        message: e.message ?? String(e),
        stack: e.stack,
      })
    }
  }
}

function domainFor(kind: ChangeKind): BuildDomain {
  if (kind === 'css') return 'app-css'
  if (kind === 'component-css') return 'component-css'
  return 'full'
}

function formatStart(ev: { paths: string[]; kind: ChangeKind }): string {
  const icon = ev.kind === 'css' ? '⎈' : '⏵'
  const label =
    ev.kind === 'css'
      ? 'css update'
      : ev.kind === 'component-css'
        ? 'component css update'
        : ev.kind === 'islands'
          ? 'islands rebuild'
          : ev.kind === 'md'
            ? 'md update'
            : 'hotreload'
  return `${icon} ${label} ${ev.paths[0]}`
}

function exportsEqualForChanged(
  before: import('../css/manifest.ts').ComponentCssManifest | null,
  after: import('../css/manifest.ts').ComponentCssManifest | null,
  paths: string[],
): boolean {
  if (!before || !after) return false
  for (const p of paths) {
    const b = before.modules[p]?.exports ?? null
    const a = after.modules[p]?.exports ?? null
    if (b === null && a === null) continue
    if (b === null || a === null) return false
    const bk = Object.keys(b).sort().join(',')
    const ak = Object.keys(a).sort().join(',')
    if (bk !== ak) return false
  }
  return true
}

function chunksForPaths(
  manifest: import('../css/manifest.ts').ComponentCssManifest | null,
  paths: string[],
): string[] {
  if (!manifest) return []
  const out = new Set<string>()
  for (const p of paths) {
    const c = manifest.modules[p]?.chunk
    if (c) out.add(c)
  }
  return Array.from(out)
}
