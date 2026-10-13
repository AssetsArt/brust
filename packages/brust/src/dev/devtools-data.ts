// Pure data helpers of the devtools overlay (no DOM at import time: unit-testable under Bun).
export type Tier = 'static' | 'native' | 'react'
export interface DevMeta { components?: Record<string, { tier: Tier }> }

export function tierCounts(rendered: string[], meta: DevMeta | null): Record<Tier, number> {
  const out = { static: 0, native: 0, react: 0 }
  for (const id of rendered) {
    const t = meta?.components?.[id]?.tier
    if (t) out[t]++
  }
  return out
}

/** Contrast ratio of two sRGB colours given as `[r, g, b]` 0..255 (WCAG 2.x). */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const [r, g, bl] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

