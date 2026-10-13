// D1 recipe — port of docs/cloudflare.md section 8 (v2, reviewed): the pokedex team roster on D1.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  migration: {
    lang: 'text',
    file: 'migrations/0001_team.sql',
    code: `CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL,
  num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL);`,
  },
  binding: {
    lang: 'json',
    file: 'wrangler.jsonc',
    code: `{ "d1_databases": [{ "binding": "TEAM_DB", "database_name": "pokedex-team", "database_id": "<paste the id>", "migrations_dir": "migrations" }] }`,
  },
  module: {
    lang: 'ts',
    file: 'lib/team-db.d1.ts',
    code: `import { env } from 'cloudflare:workers'

const INSERT =
  'INSERT INTO team (id, name, display_name, num, types, artwork, added_at) ' +
  'SELECT ?1, ?2, ?3, ?4, ?5, ?6, MAX(?7, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team)) ' +
  'WHERE (SELECT COUNT(*) FROM team) < ?8 ON CONFLICT(id) DO NOTHING'

// inside add(): one batch is one transaction. 1 row changed = added; else look the id up to tell present from full.
const [ins, has] = await env.TEAM_DB.batch([
  env.TEAM_DB.prepare(INSERT).bind(m.id, m.name, m.displayName, m.num, JSON.stringify(m.types), m.artwork, Date.now(), 6),
  env.TEAM_DB.prepare('SELECT 1 AS one FROM team WHERE id = ?1').bind(m.id),
])`,
  },
  alias: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cloudflare.alias]
"lib/team-db.ts" = "lib/team-db.d1.ts"`,
  },
  run: {
    lang: 'sh',
    cwd: '~/pokedex',
    code: `$ wrangler d1 migrations apply pokedex-team --local -c dist/cf/wrangler.jsonc    # local workerd
$ bun run dev:cf
$ wrangler d1 migrations apply pokedex-team --remote -c dist/cf/wrangler.jsonc   # before the first deploy`,
  },
} satisfies Record<string, CodeBlockInput>

export interface D1Data {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function d1Loader(): Promise<D1Data> {
  return {
    toc: [
      { id: 'migration', title: 'Migration' },
      { id: 'binding', title: 'Binding' },
      { id: 'module', title: 'The D1 module' },
      { id: 'alias', title: 'Alias' },
      { id: 'run', title: 'Apply and run' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as D1Data['blocks'],
  }
}

export default function D1({ blocks }: D1Data) {
  return (
    <>
      <h1>D1 recipe</h1>
      <p className="lead">
        The pokedex example&rsquo;s team roster: native uses <code>bun:sqlite</code>, Workers use D1. Both sit behind one async <code>TeamDb</code> interface.
      </p>

      <Step n={1} id="migration" title="Migration" />
      <CodeBlock code={blocks.migration.code} lang={blocks.migration.lang} file={blocks.migration.file} html={blocks.migration.html} />

      <Step n={2} id="binding" title="Binding" />
      <p>
        In your <code>wrangler.jsonc</code> (<code>wrangler d1 create &lt;name&gt;</code> prints the <code>database_id</code>):
      </p>
      <CodeBlock code={blocks.binding.code} lang={blocks.binding.lang} file={blocks.binding.file} html={blocks.binding.html} />

      <Step n={3} id="module" title="The D1 module" />
      <p>
        The binding is read per call. The cap of six members is one conditional statement, because D1 has no transaction handle across awaits:
      </p>
      <CodeBlock code={blocks.module.code} lang={blocks.module.lang} file={blocks.module.file} html={blocks.module.html} />

      <Step n={4} id="alias" title="Alias" />
      <CodeBlock code={blocks.alias.code} lang={blocks.alias.lang} file={blocks.alias.file} html={blocks.alias.html} />
      <p>
        Mark the sqlite module <code>server_only</code> so it never reaches a browser bundle.
      </p>

      <Step n={5} id="run" title="Apply and run" />
      <CodeBlock code={blocks.run.code} lang={blocks.run.lang} cwd={blocks.run.cwd} html={blocks.run.html} />
      <p>
        Build once first so <code>dist/cf/wrangler.jsonc</code> exists.
      </p>
      <Note>
        A D1 query counts as a subrequest, and the Free plan allows 50 queries per invocation (source C6 on <a href="/docs/cloudflare/workers">Workers target</a>, read 2026-10-12).
      </Note>
    </>
  )
}
