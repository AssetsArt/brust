// One /docs/caching prefix example: the route's cache block, one sentence on what it splits, and the transcript recorded from a real `brust start`
// (lib/cache-transcripts.json, written by scripts/capture-cache-prefix.ts and re-checked by test/cache-prefix.test.ts).
import CodeBlock from '../CodeBlock'
import type { CodeBlockData } from '../../lib/highlight'

export interface ExampleData {
  n: number
  title: string
  blurb: string
  route: string
  cache: CodeBlockData
  transcript: CodeBlockData
}

export default function PrefixExample({ ex }: { ex: ExampleData }) {
  return (
    <div className="prefix-example" style={{ minWidth: 0 }}>
      <h3>
        {ex.n}. {ex.title}
      </h3>
      <p>{ex.blurb}</p>
      <CodeBlock code={ex.cache.code} lang={ex.cache.lang} file={ex.cache.file} html={ex.cache.html} />
      <CodeBlock code={ex.transcript.code} lang={ex.transcript.lang} cwd={ex.transcript.cwd} html={ex.transcript.html} />
    </div>
  )
}
