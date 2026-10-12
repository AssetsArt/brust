// Installation — requirements, the project generator and its options, adding brust to an existing project.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import Step from '../../components/docs/Step'
import StarterPicker from '../../components/demos/StarterPicker'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { spriteUrl } from '../../lib/pokemon'

export interface InstallationData {
  toc: TocItem[]
  blocks: Record<'check' | 'create' | 'flags' | 'manual' | 'actions', CodeBlockData>
  starters: { id: string; label: string; sprite: string }[]
}

export async function installationLoader(): Promise<InstallationData> {
  return {
    toc: [
      { id: 'requirements', title: 'Check the requirements' },
      { id: 'create', title: 'Create a project' },
      { id: 'options', title: 'Generator options' },
      { id: 'existing', title: 'Add brust to an existing project' },
    ],
    blocks: {
      check: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun --version' }),
      create: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun create @brust/app@latest my-app\n$ cd my-app && bun install\n$ bun run dev' }),
      flags: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun create @brust/app@latest pokedex --template pokedex --yes\n$ bun create @brust/app@latest my-app --dir apps/web' }),
      manual: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ bun add @brust/core react react-dom' }),
      actions: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ bun add elysia@2.0.0-beta.30 @elysia/eden@2.0.0-beta.6' }),
    },
    starters: [
      { id: 'bulbasaur', label: 'Bulbasaur', sprite: spriteUrl(1) },
      { id: 'charmander', label: 'Charmander', sprite: spriteUrl(4) },
      { id: 'squirtle', label: 'Squirtle', sprite: spriteUrl(7) },
    ],
  }
}

export default function Installation({ blocks, starters }: InstallationData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Installation</h1>
      <p className="lead">brust needs Bun and nothing else: the Rust server ships prebuilt inside the npm package for your platform.</p>

      <Step n={1} id="requirements" title="Check the requirements" />
      <p>Bun 1.4 or newer, on macOS (arm64 or x64) or Linux (arm64 or x64, glibc or musl). There is no Windows build.</p>
      <CodeBlock code={blocks.check.code} lang={blocks.check.lang} cwd={blocks.check.cwd} html={blocks.check.html} />
      <p>
        You do not need a Rust toolchain. <code>@brust/core</code> lists one optional dependency per platform (<code>@brust/native-darwin-arm64</code>, <code>@brust/native-linux-x64-gnu</code>, and so on), and your package manager installs only the one that matches the machine.
      </p>

      <Step n={2} id="create" title="Create a project" />
      <p>The generator copies a template into a new folder. It has no dependencies of its own, so running it downloads nothing else.</p>
      <CodeBlock code={blocks.create.code} lang={blocks.create.lang} cwd={blocks.create.cwd} html={blocks.create.html} />
      <p>
        In a terminal it asks for one thing, the template: <code>blank</code> (one page, a native counter, an Elysia hello action) or <code>pokedex</code>. An empty answer picks <code>blank</code>. Pick a starter below to see the commands for your own project.
      </p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">StarterPicker · native</span>
        </div>
        <div className="vp">
          <StarterPicker starters={starters} />
        </div>
      </div>
      <Note>
        Keep the <code>@latest</code>. <code>bun create</code> caches the generator, and a stale cache gives you an old template.
      </Note>

      <Step n={3} id="options" title="Generator options" />
      <table>
        <thead>
          <tr>
            <th>Option</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>&lt;name&gt;</code>
            </td>
            <td>Lowercase letters, digits, <code>-</code> and <code>_</code>; starts with a letter or digit; at most 50 characters.</td>
          </tr>
          <tr>
            <td>
              <code>--template blank|pokedex</code>
            </td>
            <td>Skip the question.</td>
          </tr>
          <tr>
            <td>
              <code>--dir &lt;path&gt;</code>
            </td>
            <td>Create the project somewhere other than <code>./&lt;name&gt;</code>. The folder must be empty or missing.</td>
          </tr>
          <tr>
            <td>
              <code>--yes</code>
            </td>
            <td>Take every default without asking.</td>
          </tr>
        </tbody>
      </table>
      <CodeBlock code={blocks.flags.code} lang={blocks.flags.lang} cwd={blocks.flags.cwd} html={blocks.flags.html} />
      <p>
        <code>bun create</code> rejects the short forms <code>-t</code> and <code>-y</code>; they only work through <code>bunx</code>.
      </p>

      <Step n={4} id="existing" title="Add brust to an existing project" />
      <p>Install the core package and React 19.</p>
      <CodeBlock code={blocks.manual.code} lang={blocks.manual.lang} cwd={blocks.manual.cwd} html={blocks.manual.html} />
      <p>Actions are optional. If you want them, add the two pinned Elysia packages too:</p>
      <CodeBlock code={blocks.actions.code} lang={blocks.actions.lang} cwd={blocks.actions.cwd} html={blocks.actions.html} />
      <p>
        Then write a <code>routes.tsx</code> as in the <a href="/docs/quickstart">Quickstart</a>, and see <a href="/docs/project-structure">Project structure</a> for where each file goes.
      </p>
    </section>
  )
}
