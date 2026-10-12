// Pairs the two halves of one invalidation (cache-redis R4). lane A issues `store.invalidate` and
// `broadcast.publish` for the same args; when both arrive in the same tick ONE INVAL_LUA run does
// INCR + markers + SUNION/DEL atomically (mode `both`). Otherwise each half runs alone: `delete`
// (markers at seq+1, seq untouched, so it never jumps without an event) or `publish` (INCR + markers).
import type { RedisClient } from 'bun'
import type { InvalidateArgs } from '@brust/core/cache-adapter'
import { canonical, hasStoreWork, type Keys } from './keys'
import { evalsha, INVAL_SCRIPT } from './lua'

export type Side = 'invalidate' | 'publish'
export interface InvalResult {
  seq: number
  members: string[]
}

interface Entry {
  sides: Set<Side>
  promise: Promise<InvalResult>
}

export class Pairing {
  private readonly pending = new Map<string, Entry[]>()

  constructor(
    private readonly c: () => RedisClient,
    private readonly keys: () => Keys,
    private readonly markerTtlMs: number,
  ) {}

  run(args: InvalidateArgs, side: Side): Promise<InvalResult> {
    if (side === 'invalidate' && !hasStoreWork(args)) return Promise.resolve({ seq: 0, members: [] })
    const id = canonical(args)
    const list = this.pending.get(id) ?? []
    // Created synchronously, before any await: the partner finds it in the same tick.
    const open = list.find((e) => !e.sides.has(side))
    if (open) {
      open.sides.add(side)
      return open.promise
    }
    const entry: Entry = { sides: new Set([side]), promise: undefined as never }
    entry.promise = new Promise<InvalResult>((resolve, reject) => {
      queueMicrotask(() => {
        const l = this.pending.get(id)
        if (l) {
          l.splice(l.indexOf(entry), 1)
          if (!l.length) this.pending.delete(id)
        }
        const mode = entry.sides.size === 2 ? 'both' : side === 'invalidate' ? 'delete' : 'publish'
        this.exec(args, mode).then(resolve, reject)
      })
    })
    list.push(entry)
    this.pending.set(id, list)
    return entry.promise
  }

  private async exec(args: InvalidateArgs, mode: 'both' | 'delete' | 'publish'): Promise<InvalResult> {
    const K = this.keys()
    const method = args.method
    const tags = [...new Set(args.tags ?? [])]
    const idx: string[] = []
    const marks: string[] = []
    // A publish-only half marks but deletes nothing; a key-only publish has n = 0.
    for (const t of tags) {
      idx.push(K.tag(t))
      marks.push(K.markTag(t))
    }
    if (args.path !== undefined) {
      idx.push(K.path(method, args.path))
      marks.push(K.markPath(method, args.path))
    }
    const r = (await evalsha(this.c(), INVAL_SCRIPT, [K.seq, ...idx, ...marks], [mode, idx.length, this.markerTtlMs])) as (number | string)[]
    return { seq: Number(r[0]), members: r.slice(1).map(String) }
  }
}
