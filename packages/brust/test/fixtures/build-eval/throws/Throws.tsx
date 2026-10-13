import { buildTime } from '@brust/core'

export default function Throws() {
  const v = buildTime(() => {
    throw new Error('boom at build')
  })
  return <p>{String(v)}</p>
}
