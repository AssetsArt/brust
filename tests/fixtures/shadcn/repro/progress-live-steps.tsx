import { Progress } from 'radix-ui'
import { useState } from 'react'

// F337 (Mellow A1): the Root's attributes the chunk now recomputes print what the server printed, for every kind of
// value: a fraction, -0, a value over max, null, undefined and a boolean (both invalid: indeterminate), and a max that
// changes too.
const VALUES: unknown[] = [13, 33.5, -0, 250, null, undefined, true, 40, 50, 7]
const MAXES = [100, 100, 100, 100, 100, 100, 100, 50, 50, 0]
export default function Page() {
  const [step, setStep] = useState(0)
  const [v, setV] = useState<unknown>(13)
  const [m, setM] = useState(100)
  return (
    <div>
      <Progress.Root value={v as number | null | undefined} max={m}>
        <Progress.Indicator style={{ width: '10px' }} />
      </Progress.Root>
      <button
        onClick={() => {
          const k = (step + 1) % VALUES.length
          setStep(k)
          setV(VALUES[k])
          setM(MAXES[k]!)
        }}
      >
        go
      </button>
    </div>
  )
}
