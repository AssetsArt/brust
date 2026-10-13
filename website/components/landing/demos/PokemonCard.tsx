export default function PokemonCard({ no, name, types, art }: { no: string; name: string; types: string[]; art: string }) {
  return (
    <article className="grid min-w-0 content-start gap-[.3rem] rounded-xs border border-rule bg-paper p-[.8rem]">
      <img className="aspect-square h-auto w-full max-w-full rounded-md bg-sheet p-[.35rem]" src={art} alt={name} width="200" height="200" />
      <span className="font-mono text-[12px] text-ink-2">{no}</span>
      <h4 className="m-0 font-display text-[1rem]">{name}</h4>
      <div className="flex flex-wrap gap-[.3rem]">
        {types.map((t) => (
          <span key={t} style={{ '--ty': 'var(--ty-' + t + ')' }} className={t === 'electric' ? 'rounded-full bg-(--ty) px-2 py-[.05rem] font-mono text-[11px] text-ty-dark-fg' : 'rounded-full bg-(--ty) px-2 py-[.05rem] font-mono text-[11px] text-white'}>
            {t}
          </span>
        ))}
      </div>
    </article>
  )
}
