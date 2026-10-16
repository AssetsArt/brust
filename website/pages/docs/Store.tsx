// Store — defineStore, seeding in a loader, reading from a native component and a React island; the demo shares
// one team between a native badge, a native picker and a React island.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import TeamBadge from '../../components/demos/TeamBadge'
import TeamIsland from '../../components/demos/TeamIsland'
import TeamPicker from '../../components/demos/TeamPicker'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { byId, displayName, spriteUrl } from '../../lib/pokemon'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface StoreData {
  toc: TocItem[]
  blocks: Record<'define' | 'seed' | 'native' | 'island', CodeBlockData>
  candidates: { id: number; name: string; sprite: string }[]
}

const DEFINE = `// components/demos/team-store.ts
import { defineStore, signal } from '@brust/core/store'

export const team = defineStore('team', () => ({
  members: signal<TeamMember[]>([]),
  max: signal(6),
}))`

const SEED = `// pages/TeamPage.tsx: the page loader seeds this request's store
export async function teamPageLoader({ req }: LoaderCtx) {
  team.members.set(teamFromCookie(req.cookies.team))
  team.max.set(MAX_TEAM)
  return { ... }
}`

const NATIVE = `// components/demos/TeamBadge.tsx: native
import { useStore } from '@brust/core/store/react'
import { team } from './team-store'

export default function TeamBadge() {
  const s = useStore(team)
  return <p>Team <b>{s.members.length}</b> / {s.max}</p>
}`

const ISLAND = `// components/demos/TeamIsland.tsx: react (useTransition makes it an island)
const { members, max } = useStore(team)   // plain values, not signals
useTransition()                           // a hook the native tier does not lower
const [open, toggle] = useReducer(flip, true)`

const PICK = [25, 1, 4, 7, 133, 143, 150, 94]

export async function storeLoader(): Promise<StoreData> {
  return {
    toc: [
      { id: 'define', title: 'Define a store' },
      { id: 'seed', title: 'Seed it on the server' },
      { id: 'read', title: 'Read it anywhere' },
      { id: 'try', title: 'Try it' },
      { id: 'limits', title: 'Rules and limits' },
    ],
    blocks: {
      define: codeBlock({ lang: 'ts', file: 'components/demos/team-store.ts', code: DEFINE }),
      seed: codeBlock({ lang: 'ts', file: 'pages/TeamPage.tsx', code: SEED }),
      native: codeBlock({ lang: 'tsx', file: 'components/demos/TeamBadge.tsx', code: NATIVE }),
      island: codeBlock({ lang: 'tsx', file: 'components/demos/TeamIsland.tsx', code: ISLAND }),
    },
    candidates: PICK.map((id) => ({ id, name: displayName(byId(id)!.name), sprite: spriteUrl(id) })),
  }
}

export default function Store({ blocks, candidates }: StoreData) {
  return (
    <>
      <h1>Store</h1>
      <Lead>A store is a named bag of signals that a loader, a native component and a React island all read and write. One name, one value, three surfaces.</Lead>

      <h2 id="define">Define a store</h2>
      <CodeBlock code={blocks.define.code} lang={blocks.define.lang} file={blocks.define.file} html={blocks.define.html} />
      <p>
        Keep the name free of <code>.</code> and <code>[</code>, and keep the store in its own module, imported by the components that use it. <code>@brust/core/store</code> is React-free.
      </p>

      <h2 id="seed">Seed it on the server</h2>
      <p>
        On the server every request gets its own instance. Write it in a loader, and the page carries the values as a snapshot, so the first paint is already right, with or without JavaScript.
      </p>
      <CodeBlock code={blocks.seed.code} lang={blocks.seed.lang} file={blocks.seed.file} html={blocks.seed.html} />
      <p>
        This site is built to ship as static files, so it has no request to seed from: its pages are painted with an empty team, and the browser fills the store from its own storage when the demo mounts.
      </p>

      <h2 id="read">Read it anywhere</h2>
      <p>
        <code>useStore</code> from <code>@brust/core/store/react</code> works in both tiers. In a native component the read becomes a live binding; in an island it is <code>useSyncExternalStore</code> over the same browser instance.
      </p>
      <CodeBlock code={blocks.native.code} lang={blocks.native.lang} file={blocks.native.file} html={blocks.native.html} />
      <CodeBlock code={blocks.island.code} lang={blocks.island.lang} file={blocks.island.file} html={blocks.island.html} />
      <p>
        <code>useStore</code> alone compiles to the native tier. An island needs another React feature to be React, here <code>useTransition</code>. (<code>useReducer</code> compiles natively.)
      </p>

      <h2 id="try">Try it</h2>
      <p>
        Three components, two tiers, one store. Add a Pokémon with the native picker or remove one in the React island: the native badge follows both, with no reload. The team is the one from the <a href="/docs/actions">Actions</a> page.
      </p>
      <Frame title="store “team”" label="TeamBadge · native">
          <TeamBadge />
        
      </Frame>
      <Frame title="store “team”" label="TeamIsland · react">
          <TeamIsland />
        
      </Frame>
      <Frame title="store “team”" label="TeamPicker · native">
          <TeamPicker candidates={candidates} />
        
      </Frame>

      <h2 id="limits">Rules and limits</h2>
      <ul>
        <li>
          In a native component, read only top-level <code>signal(...)</code> keys, write only in handlers and effects, and read through the view (<code>s.members</code>), never <code>team.members()</code> in render. Each rule has a named diagnostic, and breaking one falls back to React.
        </li>
        <li>
          <code>Map</code>, <code>Set</code> and <code>Date</code> serialize to <code>{'{}'}</code>, a <code>BigInt</code> throws, functions and <code>undefined</code> are dropped.
        </li>
        <li>Navigating without a reload does not carry a snapshot.</li>
      </ul>
      <Note>
        A cached page carries its store snapshot. Do not cache pages that paint per-user store data, such as a team seeded from the reader's cookie.
      </Note>
    </>
  )
}
