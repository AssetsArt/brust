import type { DevMessage } from './ws-channel.ts'
import type { ChangeKind } from './watcher.ts'

export interface CoordinatorDeps {
  workers: {
    terminateAll(): Promise<void>
    spawnAll(): Promise<void>
  }
  buildCss: () => Promise<void>
  buildIslands: () => Promise<void>
  buildComponentCss?: () => Promise<void>
  snapshotComponentCss?: () => Promise<import('../css/manifest.ts').ComponentCssManifest | null>
  broadcast: (msg: DevMessage) => Promise<void> | void
  tui: { appendEvent(line: string): void }
}

type State = 'idle' | 'building'

export class Coordinator {
  private state: State = 'idle'

  constructor(private deps: CoordinatorDeps) {}

  async handleChange(ev: { paths: string[]; kind: ChangeKind }): Promise<void> {
    if (this.state === 'building') return
    this.state = 'building'
    const started = performance.now()
    try {
      await this.deps.broadcast({ type: 'building' })
      this.deps.tui.appendEvent(formatStart(ev))
      switch (ev.kind) {
        case 'ts':
        case 'html':
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          await this.deps.broadcast({ type: 'reload' })
          break
        case 'islands':
          await this.deps.buildIslands()
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
    } finally {
      this.state = 'idle'
    }
  }
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
