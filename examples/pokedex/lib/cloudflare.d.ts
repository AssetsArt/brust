// Ambient types for the Cloudflare Workers surface this example uses (lib/team-db.d1.ts): just the subset of D1 that
// is called, so `bun check` needs no @cloudflare/workers-types (whose global Request/Response clash with lib DOM).
interface D1Meta {
  changes: number
  last_row_id: number
}
interface D1Result<T = unknown> {
  success: boolean
  results: T[]
  meta: D1Meta
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}
declare module 'cloudflare:workers' {
  export const env: { TEAM_DB?: D1Database }
}
