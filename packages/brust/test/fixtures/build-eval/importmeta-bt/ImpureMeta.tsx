import { buildTime } from '@brust/core'

export default function ImpureMeta() {
  const h = buildTime(() => String(import.meta.env.API_URL ?? 'none'))
  return <p>{h}</p>
}
