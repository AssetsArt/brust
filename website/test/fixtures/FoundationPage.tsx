// Test fixture: one page that renders every foundation component, with its code blocks built in the loader.
import Button from '../../components/Button'
import CodeBlock from '../../components/CodeBlock'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'

export interface FoundationData {
  title: string
  page: CodeBlockData
  shell: CodeBlockData
}

export async function foundationLoader(): Promise<FoundationData> {
  return {
    title: 'Foundation · brust',
    page: codeBlock({
      lang: 'tsx',
      file: 'pages/HomePage.tsx',
      code: "export default function HomePage() {\n  return (\n    <section>\n      <h1>Hello from brust</h1>\n    </section>\n  )\n}",
    }),
    shell: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun create @brust/app@latest my-app\n$ cd my-app && bun install' }),
  }
}

export default function FoundationPage({ page, shell }: FoundationData) {
  return (
    <div className="wrap stack">
      <h2>Foundation</h2>
      <p className="muted">
        A <span className="tier static">static</span> page with <code>CodeBlock</code> and a <span className="tier native">native</span> copy button.
      </p>
      <div className="cta">
        <Button href="/docs" label="Get started" primary />
        <Button href="https://github.com/AssetsArt/brust" label="Star on GitHub" />
      </div>
      <CodeBlock code={page.code} lang={page.lang} file={page.file} html={page.html} />
      <CodeBlock code={shell.code} lang={shell.lang} cwd={shell.cwd} html={shell.html} />
    </div>
  )
}
