import { Progress } from 'radix-ui'
import { useState } from 'react'

// Condition 2 (progress-flip): Radix's own Root derives its aria/data attributes from `value` through plain module
// helpers; a value that changes must reach them.
export default function Page() {
  const [v, setV] = useState<number | null>(13)
  return (
    <div>
      <Progress.Root value={v} max={100}>
        <Progress.Indicator style={{ width: '10px' }} />
      </Progress.Root>
      <button onClick={() => setV(v === 13 ? 66 : v === 66 ? 100 : v === 100 ? null : 13)}>go</button>
    </div>
  )
}
