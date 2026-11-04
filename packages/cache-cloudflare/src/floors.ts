// Per-name invalidation floors (names `t:<tag>` and `p:<METHOD> <path>`; F493 adds prefix-scoped `px:<prefix>`,
// `pt:<prefix><tag>` and `pp:<prefix><METHOD> <path>`, the prefix JSON-quoted so names of different prefixes never meet): an
// entry written under a stamp below its floor is invalid.
import type { InvalidateArgs } from '@brust/core/cache-adapter'

export const pathName = (method: string | undefined, path: string) => `p:${method ?? 'GET'} ${path}`
const q = (prefix: string) => JSON.stringify(prefix)

/** The floor names an invalidation touches. `{ prefix }` alone floors every page of that prefix (GET pages only are stored). */
export function namesOf(args: InvalidateArgs): string[] {
  const tags = args.tags ?? []
  const pre = args.prefix
  if (pre === undefined) return [...tags.map((t) => `t:${t}`), ...(args.path !== undefined ? [pathName(args.method, args.path)] : [])]
  if (!tags.length && args.path === undefined) return args.method === undefined || args.method.toUpperCase() === 'GET' ? [`px:${q(pre)}`] : []
  return [...tags.map((t) => `pt:${q(pre)}${t}`), ...(args.path !== undefined ? [`pp:${q(pre)}${pathName(args.method, args.path).slice(2)}`] : [])]
}

/** Every floor name that covers an entry (its tags, its path, and the same scoped by its prefix). */
export function entryNames(tags: string[], method: string, path: string, prefix = ''): string[] {
  const p = q(prefix)
  return [
    ...tags.map((t) => `t:${t}`),
    pathName(method, path),
    `px:${p}`,
    ...tags.map((t) => `pt:${p}${t}`),
    `pp:${p}${pathName(method, path).slice(2)}`,
  ]
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
  floorOf(tags: string[], method: string, path: string, prefix = ''): number {
    let f = this.evicted
    for (const n of entryNames(tags, method, path, prefix)) f = Math.max(f, this.m.get(n) ?? 0)
    return f
  }
}
