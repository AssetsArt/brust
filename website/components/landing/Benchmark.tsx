// The benchmark panel: one big number and three pages, all read from bench/RESULTS.json by the page loader (lib/bench.ts).
import type { BenchData } from '../../lib/bench'
import BenchCardView from './BenchCardView'
import CountUp from './CountUp'

export default function Benchmark({ bench }: { bench: BenchData }) {
  return (
    <section className="bench3" id="bench">
      <div className="wrap">
        <h2>Measured, not promised</h2>
        <p className="setup">
          Tested with <code>oha</code>: {bench.setup.conn} concurrent connections for {bench.setup.duration} per page, brust with {bench.setup.workers} workers on a <code>{bench.setup.machine}</code>. Three
          pages from the pokedex example, each on a freshly started server.
        </p>
        <div className="hero-num">
          <span>
            <CountUp end={bench.hero.end} text={bench.hero.text} decimals={bench.hero.decimals} />
          </span>
          <small>req/s</small>
        </div>
        <p className="hero-cap">
          on a cached page, across {bench.totalText} requests in the three runs
          {bench.allOk ? (
            <>
              , every one answered <b>200 OK</b>
            </>
          ) : null}
        </p>
        <div className="bgrid">
          <BenchCardView card={bench.S} />
          <BenchCardView card={bench.I} />
          <BenchCardView card={bench.D} />
        </div>
        <p className="bfoot">
          Bars show each page's latency distribution on a linear scale, fastest to slowest response. Measured {bench.date}; the harness and every raw run are in the repo under <code>bench/</code>.
        </p>
      </div>
    </section>
  )
}
