import * as React from 'react'

function useComposed(...refs: any[]) {
  return (node: any) => refs.forEach((r) => typeof r === 'function' && r(node))
}

// F364 negative (Afrojack r2): Top and Mid only hand its forwarded ref on, to an Inner that composes it (reads it as null), so
// the page's ref is not a sink for Top or Mid either: forwarded_ref_nulled propagates up the forwardRef chain
const Inner = React.forwardRef<HTMLButtonElement, { label: string }>(function Inner({ label }, fr) {
  const cb = useComposed(fr)
  return (
    <button type="button" ref={cb}>
      {label}
    </button>
  )
})

const Mid = React.forwardRef<HTMLButtonElement, { label: string }>(function Mid({ label }, fr) {
  return <Inner label={label} ref={fr} />
})

const Top = React.forwardRef<HTMLButtonElement, { label: string }>(function Top({ label }, fr) {
  return <Mid label={label} ref={fr} />
})

export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Top label="a" ref={ref} />
    </main>
  )
}
