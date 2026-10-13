// The benchmark panel: one big number and three pages, all read from bench/RESULTS.json by the page loader (lib/bench.ts).
import type { BenchData } from '../../lib/bench'
import BenchCardView from './BenchCardView'
import CountUp from './CountUp'

export default function Benchmark({ bench }: { bench: BenchData }) {
  return (
    <section className="bg-term bg-[image:radial-gradient(circle_at_50%_30%,var(--glow),transparent_26rem),linear-gradient(var(--grid)_1px,transparent_1px),linear-gradient(90deg,var(--grid)_1px,transparent_1px)] bg-[length:auto,112px_112px,112px_112px] py-18 text-center text-term-fg" id="bench">
      <div className="mx-auto max-w-[1160px] px-4">
        <h2 className="text-gold-bright">Measured, not promised</h2>
        <p className="mx-auto mt-[.9rem] max-w-[44rem] text-[15.5px] text-term-dim">
          Tested with <code className="rounded-[4px] border border-term-rule bg-term-2 px-[.35rem] py-[.05rem] text-[13px] text-sy-str">oha</code>: {bench.setup.conn} concurrent connections for {bench.setup.duration} per page, brust with {bench.setup.workers} workers on a <code className="rounded-[4px] border border-term-rule bg-term-2 px-[.35rem] py-[.05rem] text-[13px] text-sy-str">{bench.setup.machine}</code>. Three
          pages from the pokedex example, each on a freshly started server.
        </p>
        <div className="mt-8 flex items-baseline justify-center gap-[.6rem] font-display leading-none font-light tracking-[0] tabular-nums">
          <span className="text-[clamp(3.4rem,10vw,6.6rem)] text-gold-bright [text-shadow:0_0_60px_var(--glow)]">
            <CountUp end={bench.hero.end} text={bench.hero.text} decimals={bench.hero.decimals} />
          </span>
          <small className="text-[1.15rem] font-medium tracking-[0] text-term-dim">req/s</small>
        </div>
        <p className="mt-[.6rem] text-term-dim">
          on a cached page, across {bench.totalText} requests in the three runs
          {bench.allOk ? (
            <>
              , every one answered <b className="font-medium text-sy-str">200 OK</b>
            </>
          ) : null}
        </p>
        <div className="mt-11 grid grid-cols-3 gap-4 text-left max-wide:grid-cols-1">
          <BenchCardView card={bench.S} />
          <BenchCardView card={bench.I} />
          <BenchCardView card={bench.D} />
        </div>
        <p className="mx-auto mt-8 max-w-[44rem] text-[13.5px] text-term-dim">
          Bars show each page's latency distribution on a linear scale, fastest to slowest response. Measured {bench.date}; the harness and every raw run are in the repo under <code className="rounded-[4px] border border-term-rule bg-term-2 px-[.35rem] py-[.05rem] text-[13px] text-sy-str">bench/</code>.
        </p>
      </div>
    </section>
  )
}
