// Per-name invalidation floors (names `t:<tag>` and `p:<METHOD> <path>`): an entry written under a stamp below its floor is invalid.
import type { InvalidateArgs } from '@brust/core/cache-adapter'

export const pathName = (method: string | undefined, path: string) => `p:${method ?? 'GET'} ${path}`

/** The floor names an invalidation touches. */
export function namesOf(args: InvalidateArgs): string[] {
  return [...(args.tags ?? []).map((t) => `t:${t}`), ...(args.path !== undefined ? [pathName(args.method, args.path)] : [])]
}

export interface FloorsSnapshot { names: [string, number][]; evicted: number }

export class Floors {
  private m = new Map<string, number>()
  evicted = 0
  constructor(private cap = 4096) {}
  seed(s: FloorsSnapshot): void {
    this.m.clear()
    this.evicted = s.evicted
    for (const [n, q] of s.names) this.raise(n, q)
  }
  raise(name: string, seq: number): void {
    const next = Math.max(this.m.get(name) ?? 0, seq)
    this.m.delete(name)
    this.m.set(name, next)
    while (this.m.size > this.cap) {
      const [oldest, q] = this.m.entries().next().value as [string, number]
      this.m.delete(oldest)
      this.evicted = Math.max(this.evicted, q)
    }
  }
  raiseArgs(args: InvalidateArgs, seq: number): void {
    for (const n of namesOf(args)) this.raise(n, seq)
  }
  /** The highest floor over an entry's names; a name never seen is only as safe as `evicted`. */
  floorOf(tags: string[], method: string, path: string): number {
    let f = this.evicted
    for (const n of [...tags.map((t) => `t:${t}`), pathName(method, path)]) f = Math.max(f, this.m.get(n) ?? 0)
    return f
  }
}
