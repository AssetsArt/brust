export default function Badge(props: { type: string; label: string; color: string }) {
  return <span data-type={props.type} style={{ background: props.color }}>{props.label}</span>
}
