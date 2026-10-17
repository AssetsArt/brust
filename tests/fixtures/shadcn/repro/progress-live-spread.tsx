import { Progress } from 'radix-ui'
import { useState } from 'react'

// F337 (A4): the page's props are spread into the Root, so a getValueLabel may arrive through them: not proven absent,
// the page keeps its refusal and equals React.
export default function Page(props: { getValueLabel?: (value: number, max: number) => string }) {
  const [v, setV] = useState<number | null>(13)
  return (
    <div>
      <Progress.Root value={v} max={100} {...props}>
        <Progress.Indicator style={{ width: '10px' }} />
      </Progress.Root>
      <button onClick={() => setV(v === 13 ? 66 : 13)}>go</button>
    </div>
  )
}
