import type { ReactNode } from 'react'

// A switch whose every case returns, over string literals: stacked cases, a braced case with a const, a default.
export function View({ type, children }: { type: string; children?: ReactNode }) {
  switch (type) {
    case 'hero': {
      const tag = `H:${type}`
      return <h1 data-t={tag}>{children}</h1>
    }
    case 'promo':
    case 'sale':
      return <p data-t="promo">{children}</p>
    default:
      return <div>{children}</div>
  }
}

// Over numbers: `===` is strict, so the string '1' is not the number 1.
export function Num({ n }: { n: unknown }) {
  switch (n) {
    case 1:
      return <p>one</p>
    case 2:
    case 3:
      return <p>few</p>
    default:
      return <p>other</p>
  }
}
