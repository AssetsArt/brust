export default function Leaf(props: { name: string }) {
  return (
    <article data-page={props.name}>
      <title>{props.name}</title>
      <h1>{props.name}</h1>
    </article>
  )
}
