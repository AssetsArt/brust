import Code from './Code'

export default function Exprs({ head, files }: { head: string; files: { name: string; body: string; lang?: string }[] }) {
  return (
    <main>
      <Code code={`${head}\n${head.toUpperCase()}`} lang="txt" />
      <ul>
        {files.map((f) => (
          <li key={f.name}>
            <Code code={f.body.trim()} lang={f.lang ?? 'txt'} />
          </li>
        ))}
      </ul>
    </main>
  )
}
