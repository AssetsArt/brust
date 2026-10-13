// One benchmark card: the page, its requests/second, p50 / p99 / throughput, and the real latency histogram.
import type { BenchCard } from '../../lib/bench'
import CountUp from './CountUp'
import Histogram from './Histogram'

export default function BenchCardView({ card }: { card: BenchCard }) {
  return (
    <article className={card.lead ? 'grid min-w-0 content-start rounded-xs border px-[1.4rem] pt-[1.4rem] pb-[1.1rem] motion-safe:[transition:transform_.2s,border-color_.2s] motion-safe:hover:-translate-y-[3px] border-amber-dim bg-[oklch(24%_0.05_120/.35)]' : 'grid min-w-0 content-start rounded-xs border px-[1.4rem] pt-[1.4rem] pb-[1.1rem] motion-safe:[transition:transform_.2s,border-color_.2s] motion-safe:hover:-translate-y-[3px] border-term-rule bg-term-2'}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-[1.05rem] text-term-fg">{card.title}</h3>
        <span className={card.lead ? 'rounded-full border px-[.55rem] py-[.1rem] font-mono text-[11.5px] whitespace-nowrap border-amber-dim text-amber' : 'rounded-full border px-[.55rem] py-[.1rem] font-mono text-[11.5px] whitespace-nowrap border-term-rule text-term-dim'}>{card.pill}</span>
      </header>
      <p className="mt-[.2rem] font-mono text-[12px] text-term-dim">{card.path}</p>
      <div className={card.lead ? 'mt-[1.1rem] font-display text-[2.3rem] leading-[1.05] font-normal tracking-[0] tabular-nums text-gold-bright' : 'mt-[1.1rem] font-display text-[2.3rem] leading-[1.05] font-normal tracking-[0] tabular-nums text-term-fg'}>
        <CountUp end={card.rps.end} text={card.rps.text} decimals={card.rps.decimals} />
      </div>
      <div className="mt-[.15rem] text-[11.5px] tracking-[.05em] text-term-dim uppercase">requests / second</div>
      <dl className="m-0 mt-[1.1rem] grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[11.5px] tracking-[.05em] text-term-dim uppercase">p50</dt>
          <dd className="m-0 font-mono text-[1.05rem] tabular-nums text-term-fg">
            <CountUp end={card.p50.end} text={card.p50.text} decimals={card.p50.decimals} />
            <small className="ml-[.15rem] text-[11px] text-term-dim">ms</small>
          </dd>
        </div>
        <div>
          <dt className="text-[11.5px] tracking-[.05em] text-term-dim uppercase">p99</dt>
          <dd className="m-0 font-mono text-[1.05rem] tabular-nums text-term-fg">
            <CountUp end={card.p99.end} text={card.p99.text} decimals={card.p99.decimals} />
            <small className="ml-[.15rem] text-[11px] text-term-dim">ms</small>
          </dd>
        </div>
        <div>
          <dt className="text-[11.5px] tracking-[.05em] text-term-dim uppercase">throughput</dt>
          <dd className="m-0 font-mono text-[1.05rem] tabular-nums text-term-fg">
            <CountUp end={card.mbps.end} text={card.mbps.text} decimals={card.mbps.decimals} />
            <small className="ml-[.15rem] text-[11px] text-term-dim">MB/s</small>
          </dd>
        </div>
      </dl>
      <Histogram bars={card.bars} lead={card.lead} />
      <div className="mt-[.35rem] flex justify-between font-mono text-[11px] text-term-dim">
        <span>{card.axisFrom}</span>
        <span>latency</span>
        <span>{card.axisTo}</span>
      </div>
    </article>
  )
}
