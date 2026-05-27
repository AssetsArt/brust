import type { DevMessage } from './ws-channel.ts'
import type { ChangeKind } from './watcher.ts'

export interface CoordinatorDeps {
  workers: {
    terminateAll(): Promise<void>
    spawnAll(): Promise<void>
  }
  buildCss: () => Promise<void>
  buildIslands: () => Promise<void>
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
  const label = ev.kind === 'css'     ? 'css update'
              : ev.kind === 'islands' ? 'islands rebuild'
              : 'hotreload'
  return `${icon} ${label} ${ev.paths[0]}`
}
