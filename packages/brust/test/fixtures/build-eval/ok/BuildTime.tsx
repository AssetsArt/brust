import { buildTime } from '@brust/core'
import { highlight, table } from 'tiny-fmt'

export default function BuildTimePage() {
  const html = buildTime(async () => highlight('a < b', 'ts'))
  const squares = buildTime(() => table(4))
  return (
    <main>
      <div id="code" dangerouslySetInnerHTML={{ __html: html }} />
      <p id="sq">{squares.k3}</p>
    </main>
  )
}
