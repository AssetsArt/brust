import { forwardRef } from 'react'

const Wrapped = forwardRef<HTMLDivElement, { title: string }>(function Wrapped(props, ref) {
  return <div ref={ref} title={props.title} />
})

export default Wrapped
