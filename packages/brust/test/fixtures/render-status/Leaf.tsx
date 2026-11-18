export default function Leaf(props: { title: string; why?: string }) {
  return (
    <article data-page={props.title}>
      <h1>{props.title}</h1>
      <p data-why>{props.why ?? ''}</p>
    </article>
  )
}
