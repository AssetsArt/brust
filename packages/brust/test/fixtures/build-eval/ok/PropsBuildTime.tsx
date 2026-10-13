import { buildTime } from '@brust/core'
import { highlight } from 'tiny-fmt'

export default function PropsBuildTime({ code }: { code: string }) {
  const html = buildTime(() => highlight(code, 'ts'))
  return <div dangerouslySetInnerHTML={{ __html: String(html) }} />
}
