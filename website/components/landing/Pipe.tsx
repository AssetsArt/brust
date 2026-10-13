// The build pipe above a tier panel: source file → brust build → the tier it compiles to. A tab switch sends a dot down it (class `go`, set by TierTabs).
export default function Pipe({ file, tier }: { file: string; tier: string }) {
  return (
    <div data-pipe="" className="group/pipe mb-4 flex flex-wrap items-center gap-[.6rem] font-mono text-[13px] text-ink-2">
      <span className="rounded-xs border border-rule bg-sheet px-[.55rem] py-[.2rem] text-ink">{file}</span>
      <span className="relative h-[2px] w-10 bg-rule">
        <i style={{ '--d': '0s' }} className="absolute -top-[3px] left-0 size-2 rounded-full bg-amber opacity-0 group-[.go]/pipe:motion-safe:animate-mirai-travel" />
      </span>
      <span className="rounded-xs border border-term bg-term px-[.55rem] py-[.2rem] text-term-fg">brust build</span>
      <span className="relative h-[2px] w-10 bg-rule">
        <i style={{ '--d': '.45s' }} className="absolute -top-[3px] left-0 size-2 rounded-full bg-amber opacity-0 group-[.go]/pipe:motion-safe:animate-mirai-travel" />
      </span>
      <span style={{ '--c': 'var(--t-' + tier + ')' }} className="inline-flex items-center gap-[.35rem] font-mono text-[12px] text-(--c) before:size-2 before:rounded-xs before:bg-(--c) before:content-['']">
        {tier}
      </span>
    </div>
  )
}
