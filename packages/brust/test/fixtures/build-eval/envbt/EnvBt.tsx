import { buildTime } from '@brust/core'
import { home } from './envhelper'

export default function EnvBt() {
  const h = buildTime(() => home())
  return <p>{h}</p>
}
