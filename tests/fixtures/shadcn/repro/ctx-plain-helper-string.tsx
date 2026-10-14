// The docs site's shape (website/pages/docs/ReactCoverage.tsx, Shadcn.tsx): local string helpers over a row's fields.
type Entry = { name: string; note: string }

function plainNote(e: Entry): string {
  const n = e.note.replace(/^spec §[\d.]+:?\s*/, '').trim()
  return n === e.name || n === `<${e.name}>` ? '' : n
}

const pretty = (k: string): string => k.replace(/^(fallback|error):/, '')

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ rows = [{ name: 'a', note: 'spec §1: plain a' }] }: { rows?: Entry[] }) {
  return (
    <Wrap>
      {rows.map((e) => (
        <p key={e.name}>
          {plainNote(e)}
          {pretty('fallback:x')}
          {e.note.replace(/^\w+:/, '')}
        </p>
      ))}
    </Wrap>
  )
}
