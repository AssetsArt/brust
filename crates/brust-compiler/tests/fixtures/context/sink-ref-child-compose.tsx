import * as React from 'react'

function useComposed(...refs: any[]) {
  return (node: any) => refs.forEach((r) => typeof r === 'function' && r(node))
}

// F364 negative: the child composes its forwarded ref (read as null by brust), so the page's ref is not a sink for it
const Row = React.forwardRef<HTMLButtonElement, { label: string }>(function Row({ label }, fr) {
  const cb = useComposed(fr)
  return (
    <button type="button" ref={cb}>
      {label}
    </button>
  )
})

export default function Page() {
  const ref = React.useRef<HTMLButtonElement>(null)
  return (
    <main>
      <Row label="a" ref={ref} />
    </main>
  )
}
