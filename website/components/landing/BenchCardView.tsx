// One benchmark card: the page, its requests/second, p50 / p99 / throughput, and the real latency histogram.
import type { BenchCard } from '../../lib/bench'
import CountUp from './CountUp'
import Histogram from './Histogram'

export default function BenchCardView({ card }: { card: BenchCard }) {
  return (
    <article className={card.lead ? 'bcard lead' : 'bcard'}>
      <header>
        <h3>{card.title}</h3>
        <span className="pill">{card.pill}</span>
      </header>
      <p className="path">{card.path}</p>
      <div className="rps">
        <CountUp end={card.rps.end} text={card.rps.text} decimals={card.rps.decimals} />
      </div>
      <div className="cap">requests / second</div>
      <dl>
        <div>
          <dt>p50</dt>
          <dd>
            <CountUp end={card.p50.end} text={card.p50.text} decimals={card.p50.decimals} />
            <small>ms</small>
          </dd>
        </div>
        <div>
          <dt>p99</dt>
          <dd>
            <CountUp end={card.p99.end} text={card.p99.text} decimals={card.p99.decimals} />
            <small>ms</small>
          </dd>
        </div>
        <div>
          <dt>throughput</dt>
          <dd>
            <CountUp end={card.mbps.end} text={card.mbps.text} decimals={card.mbps.decimals} />
            <small>MB/s</small>
          </dd>
        </div>
      </dl>
      <Histogram bars={card.bars} />
      <div className="hg-axis">
        <span>{card.axisFrom}</span>
        <span>latency</span>
        <span>{card.axisTo}</span>
      </div>
    </article>
  )
}
