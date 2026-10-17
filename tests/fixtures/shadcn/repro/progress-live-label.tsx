import { Progress } from 'radix-ui'
import { useState } from 'react'

// F337 (Q2/C1): a getValueLabel the call site passes: the label is a function prop the chunk cannot recompute, so the
// page keeps its refusal (React) and equals React.
export default function Page() {
  const [v, setV] = useState<number | null>(13)
  return (
    <div>
      <Progress.Root value={v} max={100} getValueLabel={(value, max) => `${value} of ${max}`}>
        <Progress.Indicator style={{ width: '10px' }} />
      </Progress.Root>
      <button onClick={() => setV(v === 13 ? 66 : 13)}>go</button>
    </div>
  )
}
