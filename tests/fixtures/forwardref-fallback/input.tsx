import * as React from 'react'

// each shape below keeps the forwardRef component React (R34.64)
const Reads = React.forwardRef<HTMLDivElement, any>(function Reads(props, ref) {
  React.useImperativeHandle(ref, () => ({ focus() {} }))
  return <div {...props} />
})
const Passes = React.forwardRef<HTMLDivElement, any>(function Passes(props, ref) {
  return <Reads ref={ref} {...props} />
})
const Destructured = React.forwardRef<HTMLDivElement, any>(function Destructured(props, { current }) {
  return <div />
})
const Plain = React.forwardRef<HTMLDivElement, any>(function Plain(props, ref) {
  return <div ref={ref} />
})

export default function Page() {
  const r = React.useRef<HTMLDivElement>(null)
  return (
    <section>
      <Reads />
      <Passes />
      <Destructured />
      <Plain ref={r} />
    </section>
  )
}
