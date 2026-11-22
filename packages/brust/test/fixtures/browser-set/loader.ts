import { PAGES } from './lib/pages'

// Server-only (only the route table imports it): it keeps items of `PAGES`, which the scan cannot follow.
const seen: unknown[] = []
export function loader() {
  for (const p of PAGES) seen.push(p)
  return { n: seen.length }
}
