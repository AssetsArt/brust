import { slugify } from './helpers'

const SIZES = [1, 2, 3]
function fmt(n: number): string {
  return n.toFixed(2)
}
function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export default function Pure() {
  const label = fmt(3.14159)
  return (
    <section>
      <h1>{label}</h1>
      <p data-slug={slugify('Hello World')}>{total(SIZES)}</p>
      <ul>
        {SIZES.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </section>
  )
}
