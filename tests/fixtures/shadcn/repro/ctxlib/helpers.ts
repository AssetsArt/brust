// F173: imported helpers, proven plain or not in their own module.
const LABELS: Record<string, string> = { a: 'A', b: 'B' }
const PREFIX = '#'
export function tag(n: number): string {
  return `${PREFIX}${n.toFixed(0)}`
}
function shout(s: string) {
  return s.toUpperCase()
}
export { shout as loud }
export function label(k: string) {
  return LABELS[k]
}
export function pick(o: { name: string }) {
  return o.name
}
export function later(n: number) {
  return n
}
export function cn(...xs: unknown[]) {
  return xs.filter((x) => x).join(' ')
}
