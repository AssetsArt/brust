// Guide: Set up shadcn/ui. The one-command flow (steps 1-4) was run on a fresh `bun create @brust/app` project with Bun 1.4.4 and the
// pinned shadcn CLI 4.21.4 (2026-10-14): docs/transcripts/shadcn-init-guide.md, files in docs/transcripts/shadcn-init-guide-app/.
// "Doing it by hand" is the earlier manual run (@brust/* 2.0.0-alpha.7, Bun 1.4.3): docs/transcripts/shadcn-setup-guide.md, files in
// docs/transcripts/shadcn-setup-guide-app/. The test checks the quoted files against those directories.
import CodeBlock from '../../../components/CodeBlock'
import Lead from '../../../components/docs/Lead'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import Tier from '../../../components/docs/Tier'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  create: {
    lang: 'sh',
    cwd: '~/',
    // transcript step 1-2
    code: `$ bun create @brust/app@latest my-app --yes
$ cd my-app && bun install`,
  },
  initCmd: {
    lang: 'sh',
    cwd: '~/my-app',
    // docs/transcripts/shadcn-init-guide.md section 1 (shadcn's own spinner lines are left out)
    code: `$ bunx brust shadcn init button card dialog
✓ components.json: done (app.css)
✓ tsconfig.json: done (added "@/*": ["./*"] under compilerOptions.paths)
bun add v1.4.4-canary.1 (408c9374b)
Saved lockfile

installed radix-ui@1.8.1
installed lucide-react@1.57.0
installed class-variance-authority@0.7.1
installed tw-animate-css@1.4.0

78 packages installed [375.00ms]
✓ dependencies: done (radix-ui@1.8.1 lucide-react@1.57.0 class-variance-authority@0.7.1 tw-animate-css@1.4.0)
✔ Checking registry.
✔ Installing dependencies.
✔ Created 1 file:
  - lib/utils.ts
✔ Updating app.css
✓ theme: done (shadcn@4.21.4 add index)
✔ Checking registry.
✔ Created 3 files:
  - components/ui/button.tsx
  - components/ui/card.tsx
  - components/ui/dialog.tsx
✓ button: done
✓ card: done
✓ dialog: done

next:
  import the components from './components/ui/<name>' in a page and add the route to routes.tsx
  bun run build`,
  },
  init: {
    lang: 'sh',
    cwd: '~/my-app',
    // transcript step 4: observed output of \`bunx shadcn@latest init -y -b radix -p nova\`
    code: `$ bunx shadcn@latest init
We could not detect a supported framework at /home/you/my-app.
Visit https://ui.shadcn.com/docs/installation/manual to manually configure your project.`,
  },
  components: {
    lang: 'json',
    file: 'components.json',
    // docs/transcripts/shadcn-setup-guide-app/components.json (same file as tests/fixtures/shadcn/components.json)
    code: `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "app.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }
}`,
  },
  paths: {
    lang: 'json',
    file: 'tsconfig.json (inside "compilerOptions")',
    // transcript step 8: `paths` alone is enough, no `baseUrl`
    code: `"paths": { "@/*": ["./*"] },`,
  },
  add: {
    lang: 'sh',
    cwd: '~/my-app',
    // transcript steps 5-6
    code: `$ bun add radix-ui lucide-react class-variance-authority tw-animate-css
$ bunx shadcn@latest add index -y
$ bunx shadcn@latest add button card dialog -y`,
  },
  css: {
    lang: 'text',
    file: 'app.css (what \`add index\` put at the top; the variables follow)',
    // docs/transcripts/shadcn-setup-guide-app/app.css:1-5
    code: `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));`,
  },
  page: {
    lang: 'tsx',
    file: 'pages/ShadcnPage.tsx',
    // docs/transcripts/shadcn-setup-guide-app/pages/ShadcnPage.tsx
    code: `import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog'

export default function ShadcnPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>shadcn/ui in brust</CardTitle>
      </CardHeader>
      <CardContent>
        <Dialog>
          <DialogTrigger asChild>
            <Button>Open</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Hello</DialogTitle>
              <DialogDescription>A Radix dialog, one React island.</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}`,
  },
  route: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `import ShadcnPage from './pages/ShadcnPage'
// in the children array, next to the home page:
{ path: '/ui', Component: ShadcnPage },`,
  },
  build: {
    lang: 'sh',
    cwd: '~/my-app',
    // docs/transcripts/shadcn-init-guide.md section 2: the first lines and the last line of the real output (the Dialog parts are the islands)
    code: `$ bun run build
warning external-component components/ui/dialog.tsx:11:10 <DialogPrimitive.Root> comes from the package radix-ui (Dialog.Root); it renders as a React island (package source: .brust/pkg-src/p-4ba0125d4d233615/src/dialog.tsx renders as React in its source: export is not a function declaration)
warning spread-props components/ui/dialog.tsx:11:10 props are spread into the React island <DialogPrimitive.Root>
…
[brust] built dist in 1208ms`,
  },
} satisfies Record<string, CodeBlockInput>

export interface ShadcnSetupData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function shadcnSetupLoader(): Promise<ShadcnSetupData> {
  return {
    toc: [
      { id: 'create', title: 'Create the project' },
      { id: 'init', title: 'Set up shadcn/ui' },
      { id: 'use', title: 'Use them in a route' },
      { id: 'build', title: 'Build and read the result' },
      { id: 'dark', title: 'Dark mode' },
      { id: 'manual', title: 'Doing it by hand' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as ShadcnSetupData['blocks'],
  }
}

export default function ShadcnSetup({ blocks }: ShadcnSetupData) {
  return (
    <>
      <h1>Set up shadcn/ui</h1>
      <Lead>
        shadcn/ui copies its components into your project, so brust compiles them like your own code. This guide takes a new brust project to a page with a card, a button and a dialog, with the commands and files exactly as they were run.
      </Lead>

      <Step n={1} id="create" title="Create the project" />
      {/* source: docs/transcripts/shadcn-setup-guide.md steps 1-2; the requirements are on the Installation page */}
      <p>
        You need <a href="/docs/installation">Bun and a generated brust project</a>. The <code>blank</code> starter already has Tailwind CSS v4 through brust&rsquo;s own plugin, so there is no separate Tailwind build to configure.
      </p>
      <CodeBlock code={blocks.create.code} lang={blocks.create.lang} cwd={blocks.create.cwd} html={blocks.create.html} />

      <Step n={2} id="init" title="Set up shadcn/ui" />
      {/* source: docs/transcripts/shadcn-init-guide.md (the real run); F175 */}
      <p>
        One command sets the project up and adds the components you name:
      </p>
      <CodeBlock code={blocks.initCmd.code} lang={blocks.initCmd.lang} cwd={blocks.initCmd.cwd} html={blocks.initCmd.html} />
      <p>It did, in order:</p>
      <ul>
        <li>wrote <code>components.json</code>, the file the shadcn CLI reads, pointing at <code>app.css</code>, the CSS file brust&rsquo;s Tailwind reads;</li>
        <li>added <code>&quot;@/*&quot;: [&quot;./*&quot;]</code> to <code>compilerOptions.paths</code> in <code>tsconfig.json</code>, keeping its comments and layout;</li>
        <li>installed <code>radix-ui</code>, <code>lucide-react</code>, <code>class-variance-authority</code> and <code>tw-animate-css</code>, each at the exact version the guide was tested with (a package you already have is left as it is);</li>
        <li>ran the shadcn CLI&rsquo;s <code>add index</code> (the theme in <code>app.css</code>, and <code>lib/utils.ts</code>) and then <code>add button card dialog</code>.</li>
      </ul>
      <p>
        It pins the shadcn CLI to one tested version instead of <code>@latest</code>, never runs a shell, and does nothing on a second run: every step says <code>skipped</code>. To add another component later, run it again with the new name. <code>--css</code>, <code>--base-color</code>, <code>--force</code> and <code>--shadcn-version</code> are described by <code>bunx brust --help</code>.
      </p>
      <Note>
        A component can also be an <code>https://</code> registry URL. That installs <strong>third-party code</strong> from that host into your project, and it runs in your build and in the browser, so read it first. The command prints a warning for each URL, skips a URL whose item is already in <code>components/</code> on a second run, and will not write through a symbolic <code>tsconfig.json</code> or <code>components.json</code> (it stops and says so).
      </Note>
      <Note>
        <code>brust shadcn init</code> needs <code>@brust/core</code> 2.0.0-alpha.11 or later. On an older project, update <code>@brust/core</code>, or follow <a href="#manual">Doing it by hand</a>.
      </Note>

      <Step n={3} id="use" title="Use them in a route" />
      {/* source: docs/transcripts/shadcn-init-guide-app/pages/ShadcnPage.tsx and routes.tsx */}
      <p>The components are files in <code>components/ui/</code>. Import them like any other component and add the page to <code>routes.tsx</code>.</p>
      <CodeBlock code={blocks.page.code} lang={blocks.page.lang} file={blocks.page.file} html={blocks.page.html} />
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />

      <Step n={4} id="build" title="Build and read the result" />
      {/* source: docs/transcripts/shadcn-init-guide.md section 2 and the browser check in its findings */}
      <p>
        <code>brust build</code> names every Radix part that renders as a <Tier t="react">React</Tier> island. These are warnings, not errors: the component works as it does in React. The card and the button are <Tier t="static">static</Tier> markup: a page with only those loads no JavaScript of its own. The dialog is where React comes in, one island per Radix part, and in the browser the <strong>Open</strong> button shows the dialog.
      </p>
      <CodeBlock code={blocks.build.code} lang={blocks.build.lang} cwd={blocks.build.cwd} html={blocks.build.html} />
      <p>
        Run it with <code>brust start</code>, or work on it with <a href="/docs/dev-mode">dev mode</a>. <a href="/docs/shadcn">shadcn/ui and React libraries</a> says which components compile and which stay islands, with the numbers from the build.
      </p>

      <Step n={5} id="dark" title="Dark mode" />
      {/* source: docs/transcripts/shadcn-setup-guide-app/app.css (:root at line 34, .dark at line 111, @custom-variant dark at line 5) */}
      <p>
        <code>add index</code> writes the variables twice: the light values under <code>:root</code> and the dark values under <code>.dark</code>, and the <code>dark:</code> variant applies below an element with the <code>dark</code> class. Put that class on <code>&lt;html&gt;</code> to switch the whole page.
      </p>

      <Step n={6} id="manual" title="Doing it by hand" />
      <p>
        <code>brust shadcn init</code> does the steps below, so you normally skip them. They are here for projects that cannot run it.
      </p>
      {/* source: docs/transcripts/shadcn-setup-guide.md step 4 (shadcn 4.21.4 does not detect brust) and step 8 (paths alone is enough) */}
      <p>
        The shadcn CLI&rsquo;s <code>init</code> does not recognise brust as a framework, so it stops there. Skip it: <code>add</code> only needs two files.
      </p>
      <CodeBlock code={blocks.init.code} lang={blocks.init.lang} cwd={blocks.init.cwd} html={blocks.init.html} />
      <p>
        <code>components.json</code> at the project root says where things go: the style, the CSS file (<code>app.css</code>, the one brust&rsquo;s Tailwind reads) and the aliases.
      </p>
      <CodeBlock code={blocks.components.code} lang={blocks.components.lang} file={blocks.components.file} html={blocks.components.html} />
      <p>
        The aliases start with <code>@/</code>, and the CLI resolves them through <code>tsconfig.json</code>. Add one line to its <code>compilerOptions</code>; no <code>baseUrl</code> is needed:
      </p>
      <CodeBlock code={blocks.paths.code} lang={blocks.paths.lang} file={blocks.paths.file} html={blocks.paths.html} />
      <Note>
        The imports the CLI writes into the components it adds (<code>@/components/ui/button</code> in the dialog) build as they are, with this one line.
      </Note>
      {/* source: docs/transcripts/shadcn-setup-guide.md steps 5-6 */}
      <p>
        <code>add index</code> is the part of <code>init</code> you need: it adds the Tailwind imports, the light and dark colour variables and the <code>@theme</code> block to <code>app.css</code>, creates <code>lib/utils.ts</code> and installs <code>shadcn</code> and <code>tw-animate-css</code>. Then add the components. The CLI installs <code>cn</code>, the class-name helper the components import, as a package; there is no helper to write yourself.
      </p>
      <CodeBlock code={blocks.add.code} lang={blocks.add.lang} cwd={blocks.add.cwd} html={blocks.add.html} />
      <CodeBlock code={blocks.css.code} lang={blocks.css.lang} file={blocks.css.file} html={blocks.css.html} />
    </>
  )
}
