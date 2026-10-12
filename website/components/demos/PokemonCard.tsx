// Demo, static tier: props in, markup out. No state and no handlers, so it ships no JavaScript.
export default function PokemonCard({ no, name, art, types }: { no: string; name: string; art: string; types: string[] }) {
  return (
    <article className="pk">
      <img src={art} alt={name} width={200} height={200} loading="lazy" />
      <span className="no">{no}</span>
      <h4>{name}</h4>
      <div>
        {types.map((t) => (
          <span key={t} className={`ty ${t}`}>
            {t}
          </span>
        ))}
      </div>
    </article>
  )
}
