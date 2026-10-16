import { useState } from 'react'

function Inner({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  const [on, setOn] = useState(false)
  return (
    <label {...rest} data-on={on} onClick={() => setOn(!on)}>
      {children}
    </label>
  )
}
function Outer({ ...props }: { [k: string]: unknown }) {
  return <Inner data-slot="x" {...props} />
}
export default function Page() {
  return <Outer title="t">hello</Outer>
}
