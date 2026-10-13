// The landing page: hero, facts, benchmark (bench/RESULTS.json), steps, tiers with three live demos, data, actions + store, deploy, packages, not-list, closing band.
// All code blocks, the benchmark numbers and the version are built here in the loader (never in a component: see lib/highlight.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ActionsStore from '../components/landing/ActionsStore'
import Benchmark from '../components/landing/Benchmark'
import Closing from '../components/landing/Closing'
import { type LandingCode, landingCode } from '../components/landing/snippets'
import DataSection from '../components/landing/DataSection'
import { type CardData, type CatchData, demoData, type SearchItem } from '../components/landing/demoData'
import Deploy from '../components/landing/Deploy'
import RequestPath from '../components/landing/RequestPath'
import Hero from '../components/landing/Hero'
import SecHead from '../components/landing/SecHead'
import ShipBar from '../components/landing/ShipBar'
import UrlBar from '../components/landing/UrlBar'
import Nots from '../components/landing/Nots'
import Packages from '../components/landing/Packages'
import Steps from '../components/landing/Steps'
import NativePanel from '../components/landing/NativePanel'
import PokemonSearch from '../components/landing/demos/PokemonSearch'
import Pipe from '../components/landing/Pipe'
import StaticPanel from '../components/landing/StaticPanel'
import TierTabs from '../components/landing/TierTabs'
import CodeBlock from '../components/CodeBlock'
import { type BenchData, loadBench } from '../lib/bench'

export interface HomeData {
  title: string
  version: string
  sealMajor: string
  sealLabel: string
  bench: BenchData
  code: LandingCode
  a: CardData
  b: CardData
  c: CardData
  catchData: CatchData
  all: SearchItem[]
}

/** The @brust/core version the site runs on (the workspace package.json): the tmux session and the seal print it. */
function coreVersion(): string {
  return String((JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'packages', 'brust', 'package.json'), 'utf8')) as { version?: string }).version ?? '')
}

export async function homeLoader(): Promise<HomeData> {
  const version = coreVersion()
  const pre = /^\d+\.\d+\.\d+-(.+)$/.exec(version)?.[1] ?? ''
  return {
    title: 'brust — React you write. Rust that serves it.',
    version,
    sealMajor: version.split('.')[0] ?? '',
    sealLabel: pre.replace('.', ' '),
    bench: loadBench(),
    code: landingCode(),
    ...demoData(),
  }
}

export default function HomePage(d: HomeData) {
  return (
    <div>
      <Hero version={d.version} />
      <RequestPath />
      <Benchmark bench={d.bench} />
      <Steps create={d.code.create} write={d.code.write} run={d.code.run} />
      {/* The tiers section is written out here, not as a component: the React island (PokemonSearch, an ssr job) must sit in the page's own template. */}
      <section className="border-t border-rule py-18">
        <div className="mx-auto max-w-[1160px] px-4">
          <SecHead
            title="One component model, three outputs"
            lede="You write ordinary React. The compiler reads each component, picks the cheapest output that still behaves the same, and tells you what it picked. Left is the code, right is what the browser shows."
          />
          <TierTabs />
          <StaticPanel code={d.code.staticDemo} a={d.a} b={d.b} c={d.c} />
          <NativePanel code={d.code.nativeDemo} card={d.catchData} />
          <div className="pt-7 [&.enter]:motion-safe:animate-mirai-enter" role="tabpanel" id="p-react" aria-labelledby="tab-react" hidden>
            <Pipe file="PokemonSearch.tsx" tier="react" />
            <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-stretch gap-5 max-wide:grid-cols-1 [&_pre]:max-h-[30rem] [&_pre]:overflow-auto">
              <CodeBlock code={d.code.reactDemo.code} lang={d.code.reactDemo.lang} file={d.code.reactDemo.file} cwd={d.code.reactDemo.cwd} html={d.code.reactDemo.html} />
              <div className="flex min-w-0 flex-col overflow-hidden rounded-xs border border-rule bg-sheet">
                <UrlBar url="127.0.0.1:1337/search" label="Rendered · try it" />
                <PokemonSearch all={d.all} />
                <ShipBar a={{ k: 'HTML', v: 'server-rendered with React' }} b={{ k: 'JavaScript', v: 'one React chunk' }} c={{ k: 'Where', v: 'only pages that use it' }} />
              </div>
            </div>
          </div>
        </div>
      </section>
      <DataSection route={d.code.route} invalidate={d.code.invalidate} />
      <ActionsStore actions={d.code.actions} client={d.code.client} store={d.code.store} teamCount={d.code.teamCount} />
      <Deploy selfHost={d.code.selfHost} workers={d.code.workers} />
      <Packages />
      <Nots />
      <Closing major={d.sealMajor} label={d.sealLabel} />
    </div>
  )
}
