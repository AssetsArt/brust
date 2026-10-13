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
    <div className="landing">
      <Hero version={d.version} />
      <RequestPath />
      <Benchmark bench={d.bench} />
      <Steps create={d.code.create} write={d.code.write} run={d.code.run} />
      {/* The tiers section is written out here, not as a component: the React island (PokemonSearch, an ssr job) must sit in the page's own template. */}
      <section className="sec">
        <div className="wrap">
          <div className="head">
            <h2>One component model, three outputs</h2>
            <p>
              You write ordinary React. The compiler reads each component, picks the cheapest output that still behaves the same, and tells you what it picked. Left is the code, right is what the browser
              shows.
            </p>
          </div>
          <TierTabs />
          <StaticPanel code={d.code.staticDemo} a={d.a} b={d.b} c={d.c} />
          <NativePanel code={d.code.nativeDemo} card={d.catchData} />
          <div className="panel cr" role="tabpanel" id="p-react" aria-labelledby="tab-react" hidden>
            <Pipe file="PokemonSearch.tsx" tier="react" />
            <div className="cr-grid">
              <CodeBlock code={d.code.reactDemo.code} lang={d.code.reactDemo.lang} file={d.code.reactDemo.file} cwd={d.code.reactDemo.cwd} html={d.code.reactDemo.html} />
              <div className="browser">
                <div className="url">
                  <span>127.0.0.1:1337/search</span>
                  <span className="lbl">Rendered · try it</span>
                </div>
                <PokemonSearch all={d.all} />
                <dl className="shipbar">
                  <div>
                    <dt>HTML</dt>
                    <dd>server-rendered with React</dd>
                  </div>
                  <div>
                    <dt>JavaScript</dt>
                    <dd>one React chunk</dd>
                  </div>
                  <div>
                    <dt>Where</dt>
                    <dd>only pages that use it</dd>
                  </div>
                </dl>
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
