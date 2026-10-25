export default function Block(props: { name: string }) {
  return <div data-page={props.name}>{props.name}</div>
}
