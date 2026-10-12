// A landing code block: CodeBlock fed from one loader-built CodeBlockData (a plain props path, so the page needs no precompute job).
import CodeBlock from '../CodeBlock'
import type { CodeBlockData } from '../../lib/highlight'

export default function Code({ b }: { b: CodeBlockData }) {
  return <CodeBlock code={b.code} lang={b.lang} file={b.file} cwd={b.cwd} html={b.html} />
}
