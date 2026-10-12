export default function PokemonCard({ no, name, types, art }: { no: string; name: string; types: string[]; art: string }) {
  return (
    <article className="pk">
      <img src={art} alt={name} width="200" height="200" />
      <span className="no">{no}</span>
      <h4>{name}</h4>
      <div>
        {types.map((t) => (
          <span key={t} className={'ty ' + t}>
            {t}
          </span>
        ))}
      </div>
    </article>
  )
}
