// bench/lib/balance.ts — did SO_REUSEPORT actually spread the load over the bun-serve copies? (lead ruling on the
// ceiling challenge: every process must have served >= 5% of the requests, else the ceiling is labelled 1-proc.)
export const MIN_SHARE = 0.05
export interface Balance { counts: number[]; total: number; minShare: number; ok: boolean }
export function checkBalance(counts: number[]): Balance {
  const total = counts.reduce((a, b) => a + b, 0)
  const minShare = total === 0 || counts.length === 0 ? 0 : Math.min(...counts) / total
  return { counts, total, minShare, ok: counts.length > 0 && minShare >= MIN_SHARE }
}
