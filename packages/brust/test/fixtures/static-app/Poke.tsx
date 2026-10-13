import Counter from './Counter'

export default function Poke(props: { name: string }) {
  return (
    <article>
      <h1 className="poke">{props.name}</h1>
      <Counter label={props.name} />
    </article>
  )
}
