// The Cloudflare subset this package uses, declared ambiently: @cloudflare/workers-types' global Request/Response clash with
// lib DOM under `bun check` (same precedent as examples/pokedex/lib/cloudflare.d.ts).
interface KVNamespaceGetOptions { type?: 'text' | 'arrayBuffer'; cacheTtl?: number }
interface KVNamespace {
  get(key: string, options: { type: 'arrayBuffer'; cacheTtl?: number }): Promise<ArrayBuffer | null>
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}
interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[]
  one(): T
  readonly rowsWritten: number
}
interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>
}
interface DurableObjectStorage {
  sql: SqlStorage
  transactionSync<T>(fn: () => T): T
  setAlarm(time: number): Promise<void>
  getAlarm(): Promise<number | null>
}
interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
  export class DurableObject<E = Record<string, unknown>> {
    constructor(ctx: DurableObjectState, env: E)
    protected ctx: DurableObjectState
    protected env: E
  }
}
