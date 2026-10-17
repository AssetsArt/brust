import * as React from 'react'

// F364 negative (Mellow): the child prints its forwarded ref as a value AND binds it; React gives it the page's ref
// object (`[object Object]`, `y`), brust would give null (`null`, `n`)
const Row = React.forwardRef<HTMLSpanElement, { label: string }>(function Row({ label }, fr) {
  return (
    <span ref={fr} data-r={String(fr)} data-has={fr ? 'y' : 'n'}>
      {label}
    </span>
  )
})

export default function Page() {
  const ref = React.useRef<HTMLSpanElement>(null)
  return (
    <main>
      <Row label="a" ref={ref} />
    </main>
  )
}
