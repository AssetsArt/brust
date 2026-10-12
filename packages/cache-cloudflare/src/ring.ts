// The epoch ring: events with strictly increasing seqs, bounded by count and bytes. Mirrors the memory adapter's pull mode.
import type { EpochSince, InvalidateArgs, InvalidationEvent } from '@brust/core/cache-adapter'

/** An event whose JSON is larger is kept as a "clear" marker: whoever is before it gets `behind`. */
export const OVERSIZE_EVENT = 64 * 1024

interface Slot { seq: number; bytes: number; event: InvalidationEvent | null }

export class Ring {
  seq: number
  private slots: Slot[] = []
  private used = 0
  /** The highest seq no longer retained. */
  private dropped = 0
  constructor(readonly gen: string, startSeq = 0, private capEntries = 1024, private capBytes = 1 << 20) {
    this.seq = startSeq
  }
  publish(args: InvalidateArgs, origin: string): number {
    this.seq += 1
    const event: InvalidationEvent = { seq: this.seq, origin, args: structuredClone(args) }
    const bytes = JSON.stringify(event).length
    this.slots.push({ seq: this.seq, bytes: Math.min(bytes, OVERSIZE_EVENT), event: bytes > OVERSIZE_EVENT ? null : event })
    this.used += this.slots[this.slots.length - 1]!.bytes
    while (this.slots.length > this.capEntries || this.used > this.capBytes) {
      const old = this.slots.shift()!
      this.used -= old.bytes
      this.dropped = old.seq
    }
    return this.seq
  }
  since(from: number): EpochSince {
    const after = this.slots.filter((s) => s.seq > from)
    const behind = from < this.dropped || from > this.seq || after.some((s) => s.event === null)
    return { gen: this.gen, seq: this.seq, behind, events: behind ? [] : after.map((s) => structuredClone(s.event!)) }
  }
}
