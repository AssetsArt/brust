// The push half (cache-redis R7, R8): a dedicated subscriber connection with the adapter-owned
// reconnect loop, and a gap check on every (re)subscribe so an event lost during an outage clears
// tier 1 (spec §4.2.5) instead of leaving a stale page for up to its ttl.
import type { InvalidationEvent } from '@brust/core/cache-adapter'
import { Link } from './conn'
import type { Keys } from './keys'
import type { ResolvedOptions } from './options'

export interface SubscriberState {
  link: Link | null
  subscribed: boolean
  last: number | null
}

export async function startSubscriber(
  o: ResolvedOptions,
  keys: Keys,
  readSeq: () => Promise<number>,
  state: SubscriberState,
  on: (e: InvalidationEvent) => void,
  onGap: () => void,
): Promise<() => Promise<void>> {
  const listener = (message: string) => {
    let e: InvalidationEvent
    try {
      const j = JSON.parse(message) as Partial<InvalidationEvent>
      if (!Number.isSafeInteger(j.seq) || typeof j.origin !== 'string' || typeof j.args !== 'object' || j.args === null) throw new Error('shape')
      e = j as InvalidationEvent
    } catch {
      console.warn('[brust] cache-redis: dropped a malformed invalidation message')
      return
    }
    state.last = Math.max(state.last ?? 0, e.seq)
    try {
      on(e)
    } catch (err) {
      console.error(`[brust] cache-redis: invalidation handler failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const link = new Link(o, 'subscriber', async (cl) => {
    state.subscribed = false
    await cl.subscribe(keys.channel, listener)
    // The command link may be down too: a throw here drops this attempt and retries after the backoff.
    const seq = await readSeq()
    const first = state.last === null
    if (first) state.last = seq
    else if (seq > state.last!) {
      state.last = seq
      try {
        onGap()
      } catch (err) {
        console.error(`[brust] cache-redis: gap handler failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    state.subscribed = true
  }, () => {
    state.subscribed = false
  })
  state.link = link
  await link.start()
  return async () => {
    link.close()
    state.subscribed = false
  }
}
