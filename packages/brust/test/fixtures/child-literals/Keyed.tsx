import { cache } from '@brust/core'

// Same job as Code, cached under the code itself: two literals must still land on two entries.
function Keyed({ code }: { code: string }) {
  return (
    <pre>
      {code
        .split('\n')
        .filter((l) => l.length > 0)
        .join('+')}
    </pre>
  )
}

export default cache(Keyed, { key: (p) => p.code })
