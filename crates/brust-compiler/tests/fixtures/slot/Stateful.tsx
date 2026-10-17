import { useState } from 'react'

// F363a negative: state of its own (a native component), which would need its own instance in the child's place
export default function Stateful({ ...props }: any) {
  const [n, setN] = useState(0)
  return <a {...props} data-n={n} onClick={() => setN(n + 1)} />
}
