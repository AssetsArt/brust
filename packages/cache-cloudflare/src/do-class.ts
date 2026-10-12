// BrustCacheDO: ONE class for both roles. The instance named `epoch:<ns>` is the broadcast (ring + persisted seq and floors); instances named
// `store:<ns>:<0..f>` are body shards (exact write guard). SQLite-backed (migrations `new_sqlite_classes`). seq and the name -> seq floors
// persist (R7) so seqs never regress across a restart; the ring stays in memory and `gen` is new on every construction, so isolates clear once.
import { DurableObject } from 'cloudflare:workers'
import type { EpochSince, InvalidateArgs } from '@brust/core/cache-adapter'
import { namesOf, pathName } from './floors'
import { Ring } from './ring'

export const INVAL_CAP = 4096
const SWEEP_MS = 60_000

export interface PageMeta { tags: string[]; method: string; path: string; expiresAt: number }
export interface FloorsPayload { gen: string; seq: number; names: [string, number][]; evicted: number }

export class BrustCacheDO extends DurableObject {
  private sql: SqlStorage
  private gen = crypto.randomUUID()
  private ring = new Ring(this.gen, 0)
  private evicted = 0
  private invalCount = 0
  private publishes = 0
  private failNext = false

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    void ctx.blockConcurrencyWhile(async () => {
      const sql = this.sql
      sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER)')
      sql.exec('CREATE TABLE IF NOT EXISTS inval(name TEXT PRIMARY KEY, seq INTEGER NOT NULL)')
      sql.exec('CREATE INDEX IF NOT EXISTS inval_seq ON inval(seq)')
      sql.exec('CREATE TABLE IF NOT EXISTS pages(key TEXT PRIMARY KEY, meta TEXT NOT NULL, body BLOB NOT NULL, mpath TEXT NOT NULL, expires_at INTEGER NOT NULL)')
      sql.exec('CREATE TABLE IF NOT EXISTS tags(tag TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(tag, key))')
      const m = (k: string) => (sql.exec<{ v: number }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? 0)
      this.evicted = m('evicted')
      this.invalCount = sql.exec<{ c: number }>('SELECT count(*) AS c FROM inval').one().c
      this.ring = new Ring(this.gen, m('seq'))
    })
  }

  private testOnly(): void {
    if ((this.env as Record<string, unknown>).BRUST_CACHE_TEST !== '1') throw new Error('BrustCacheDO: test hooks are disabled')
  }
  private maybeFail(): void {
    if (this.failNext) {
      this.failNext = false
      throw new Error('BrustCacheDO: injected failure')
    }
  }
  private setMeta(k: string, v: number): void {
    this.sql.exec('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v)
  }

  /** Raise the floors of `names` to at least `seq`; keep at most INVAL_CAP rows, raising `evicted` by what is dropped. */
  private bump(names: string[], seq: number): void {
    for (const n of names) {
      if (this.sql.exec('SELECT 1 FROM inval WHERE name = ?', n).toArray().length === 0) this.invalCount += 1
      this.sql.exec('INSERT INTO inval(name, seq) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET seq = max(seq, excluded.seq)', n, seq)
    }
    const over = this.invalCount - INVAL_CAP
    if (over > 0) {
      const old = this.sql.exec<{ name: string; seq: number }>('SELECT name, seq FROM inval ORDER BY seq ASC LIMIT ?', over).toArray()
      for (const o of old) {
        this.sql.exec('DELETE FROM inval WHERE name = ?', o.name)
        this.evicted = Math.max(this.evicted, o.seq)
      }
      this.invalCount -= old.length
      this.setMeta('evicted', this.evicted)
    }
  }

  // ---- epoch role ----
  head(): { gen: string; seq: number } {
    return { gen: this.gen, seq: this.ring.seq }
  }
  since(seq: number): EpochSince {
    this.maybeFail()
    return this.ring.since(seq)
  }
  publish(args: InvalidateArgs, origin: string): { gen: string; seq: number } {
    this.maybeFail()
    this.publishes += 1
    return this.ctx.storage.transactionSync(() => {
      const seq = this.ring.publish(args, origin)
      this.setMeta('seq', seq)
      this.bump(namesOf(args), seq)
      return { gen: this.gen, seq }
    })
  }
  floors(): FloorsPayload {
    const rows = this.sql.exec<{ name: string; seq: number }>('SELECT name, seq FROM inval ORDER BY seq DESC LIMIT ?', INVAL_CAP).toArray()
    return { gen: this.gen, seq: this.ring.seq, names: rows.map((r) => [r.name, r.seq]), evicted: this.evicted }
  }

  // ---- shard role ----
  get(key: string): Uint8Array | null {
    const row = this.sql.exec<{ body: ArrayBuffer; expires_at: number }>('SELECT body, expires_at FROM pages WHERE key = ?', key).toArray()[0]
    if (!row) return null
    if (row.expires_at <= Date.now()) {
      this.dropKeys([key])
      return null
    }
    return new Uint8Array(row.body)
  }
  /** `stamp === null` = an unguarded write (the same rule as every store); otherwise refused when an invalidation of its names is newer. */
  async set(key: string, frame: Uint8Array, meta: PageMeta, stamp: number | null): Promise<boolean> {
    const ok = this.ctx.storage.transactionSync(() => {
      if (stamp !== null) {
        if (this.evicted > stamp) return false
        for (const n of [...meta.tags.map((t) => `t:${t}`), pathName(meta.method, meta.path)]) {
          const r = this.sql.exec<{ seq: number }>('SELECT seq FROM inval WHERE name = ?', n).toArray()[0]
          if (r && r.seq > stamp) return false
        }
      }
      this.dropKeys([key])
      this.sql.exec('INSERT INTO pages(key, meta, body, mpath, expires_at) VALUES(?, ?, ?, ?, ?)', key, JSON.stringify({ tags: meta.tags, method: meta.method, path: meta.path }), frame, pathName(meta.method, meta.path), meta.expiresAt)
      for (const t of new Set(meta.tags)) this.sql.exec('INSERT OR IGNORE INTO tags(tag, key) VALUES(?, ?)', t, key)
      return true
    })
    if (ok && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS)
    return ok
  }
  invalidate(args: InvalidateArgs, seq: number): number {
    return this.ctx.storage.transactionSync(() => {
      this.bump(namesOf(args), seq)
      const keys = new Set<string>()
      for (const t of args.tags ?? []) for (const r of this.sql.exec<{ key: string }>('SELECT key FROM tags WHERE tag = ?', t)) keys.add(r.key)
      if (args.path !== undefined) for (const r of this.sql.exec<{ key: string }>('SELECT key FROM pages WHERE mpath = ?', pathName(args.method, args.path))) keys.add(r.key)
      this.dropKeys([...keys])
      return keys.size
    })
  }
  private dropKeys(keys: string[]): void {
    for (const k of keys) {
      this.sql.exec('DELETE FROM pages WHERE key = ?', k)
      this.sql.exec('DELETE FROM tags WHERE key = ?', k)
    }
  }
  async alarm(): Promise<void> {
    const dead = this.sql.exec<{ key: string }>('SELECT key FROM pages WHERE expires_at <= ?', Date.now()).toArray()
    this.dropKeys(dead.map((r) => r.key))
    if (this.sql.exec('SELECT 1 FROM pages LIMIT 1').toArray().length > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS)
  }

  // ---- test hooks (R12): only when env.BRUST_CACHE_TEST === "1" ----
  __regen(): { gen: string; seq: number } {
    this.testOnly()
    this.gen = crypto.randomUUID()
    this.ring = new Ring(this.gen, this.ring.seq)
    return { gen: this.gen, seq: this.ring.seq }
  }
  __failNext(): void {
    this.testOnly()
    this.failNext = true
  }
  async __sweep(): Promise<void> {
    this.testOnly()
    await this.alarm()
  }
  __state(): { publishes: number; seq: number; gen: string; pages: number; inval: number; evicted: number } {
    this.testOnly()
    const pages = this.sql.exec<{ c: number }>('SELECT count(*) AS c FROM pages').one().c
    return { publishes: this.publishes, seq: this.ring.seq, gen: this.gen, pages, inval: this.invalCount, evicted: this.evicted }
  }
}
