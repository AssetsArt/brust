import { useState } from 'react'

// The live pathStepper shape: the row's own text reads its index, and a middle row is shown first.
const STEPS = [{ name: 'build' }, { name: 'deploy' }, { name: 'serve' }]
export default function PStepper() {
  const [pick, setPick] = useState(1)
  return (
    <main>
      <button type="button" data-testid="first" onClick={() => setPick(0)}>
        first
      </button>
      {STEPS.map((s, i) => (
        <p key={s.name} hidden={pick !== i}>
          Step {i + 1} · {s.name}
        </p>
      ))}
    </main>
  )
}
