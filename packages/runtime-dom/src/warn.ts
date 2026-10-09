const seen = new Set<string>()
export function warnOnce(key: string, message: string): void {
  if (seen.has(key)) return
  seen.add(key)
  console.warn(`[brust] ${message}`)
}

/** test-only; the browser harness calls it between cases */
export function __resetWarnOnce(): void { seen.clear() }
