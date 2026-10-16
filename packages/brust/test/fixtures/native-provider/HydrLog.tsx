import { useEffect, useState } from 'react'
import { useIsHydrated } from './rhydr'

// records what the hydration flag was each time the effect ran
export default function HydrLog({ name }: { name: string }) {
  const hydrated = useIsHydrated()
  const [log, setLog] = useState('')
  useEffect(() => {
    setLog((l) => l + (hydrated ? '1' : '0'))
  }, [hydrated])
  return (
    <output data-name={name} data-h={hydrated ? 'y' : 'n'} data-log={log}>
      {name}
    </output>
  )
}
