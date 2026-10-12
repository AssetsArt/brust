// The Worker env, read per call: a Worker may not touch bindings at module scope, and the bundle's smoke import runs with env = {}.
export type GetEnv = () => Promise<Record<string, unknown>>
export const workersEnv: GetEnv = async () => (await import('cloudflare:workers')).env

export function binding<T>(env: Record<string, unknown>, name: string, what: string): T {
  const b = env[name]
  if (b === undefined || b === null) throw new Error(`${what} binding "${name}" is not bound (add it to wrangler.jsonc)`)
  return b as T
}

/** Only the listed keys; anything else is a TypeError naming it (it surfaces at the build smoke). */
export function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], ignored: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k) && !ignored.includes(k)) throw new TypeError(`${what}: unknown option "${k}" (known: ${allowed.join(', ')})`)
}
