export default function C(props: any) {
  return <ul>{props.items.map((i: string) => <li key={i}>{i}:{props.label}</li>)}</ul>
}
