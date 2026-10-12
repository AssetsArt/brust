import type { InvalidateArgs } from '@brust/core/cache-adapter'
import type { EpochStub, ShardStub } from '../src/do-adapter'
import { namesOf } from '../src/floors'
import { Ring } from '../src/ring'

export class FakeEpoch implements EpochStub {
  ring = new Ring('g1', 0)
  names = new Map<string, number>()
  evicted = 0
  publishes = 0
  floorsCalls = 0
  fail = 0
  async head() { return { gen: this.ring.gen, seq: this.ring.seq } }
  async since(seq: number) { return this.ring.since(seq) }
  async publish(args: InvalidateArgs, origin: string) {
    if (this.fail > 0) { this.fail--; throw new Error('boom') }
    this.publishes++
    const seq = this.ring.publish(args, origin)
    for (const n of namesOf(args)) this.names.set(n, seq)
    return { gen: this.ring.gen, seq }
  }
  async floors() {
    this.floorsCalls++
    return { gen: this.ring.gen, seq: this.ring.seq, names: [...this.names], evicted: this.evicted }
  }
  regen() { this.ring = new Ring('g' + Math.random(), this.ring.seq) }
}
export class FakeShard implements ShardStub {
  invalidates: { args: InvalidateArgs; seq: number }[] = []
  rows = new Map<string, Uint8Array>()
  async get(key: string) { return this.rows.get(key) ?? null }
  async set(key: string, frame: Uint8Array) { this.rows.set(key, frame); return true }
  async invalidate(args: InvalidateArgs, seq: number) { this.invalidates.push({ args, seq }); return 0 }
}
/** An env whose DO binding hands out one fake per name. */
export function fakeDoEnv(binding = 'BRUST_CACHE_DO') {
  const stubs = new Map<string, FakeEpoch | FakeShard>()
  const ns = {
    getByName(name: string) {
      let s = stubs.get(name)
      if (!s) { s = name.startsWith('epoch:') ? new FakeEpoch() : new FakeShard(); stubs.set(name, s) }
      return s
    },
  }
  return { env: { [binding]: ns } as Record<string, unknown>, stubs, epoch: (n = 'ns') => ns.getByName(`epoch:${n}`) as FakeEpoch, shard: (i: number, n = 'ns') => ns.getByName(`store:${n}:${i}`) as FakeShard }
}
