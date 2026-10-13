// The three-cell "what ships" row under a "browser" frame (HTML / JavaScript / the third fact); a dim value reads as "none".
export interface Ship {
  k: string
  v: string
  no?: boolean
}

export default function ShipBar({ a, b, c }: { a: Ship; b: Ship; c: Ship }) {
  return (
    <dl className="m-0 grid grid-cols-3 border-t border-rule max-narrow:grid-cols-1 [&>div]:min-w-0 [&>div]:border-l [&>div]:border-rule [&>div]:px-[.8rem] [&>div]:py-[.6rem] [&>div:first-child]:border-l-0 max-narrow:[&>div]:border-l-0 max-narrow:[&>div]:border-t max-narrow:[&>div:first-child]:border-t-0">
      <div>
        <dt className="text-[12px] text-ink-2">{a.k}</dt>
        <dd className={a.no ? 'm-0 font-mono text-[12.5px] text-ink-2' : 'm-0 font-mono text-[12.5px]'}>{a.v}</dd>
      </div>
      <div>
        <dt className="text-[12px] text-ink-2">{b.k}</dt>
        <dd className={b.no ? 'm-0 font-mono text-[12.5px] text-ink-2' : 'm-0 font-mono text-[12.5px]'}>{b.v}</dd>
      </div>
      <div>
        <dt className="text-[12px] text-ink-2">{c.k}</dt>
        <dd className={c.no ? 'm-0 font-mono text-[12.5px] text-ink-2' : 'm-0 font-mono text-[12.5px]'}>{c.v}</dd>
      </div>
    </dl>
  )
}
