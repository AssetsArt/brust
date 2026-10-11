// Stateless: a static child fed one row of List.
export default function Row(props: { name: string }) {
  return <li>{props.name}</li>
}
