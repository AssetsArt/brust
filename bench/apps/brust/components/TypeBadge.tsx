// Static child fed by the loader (label/color precomputed): no job, so it may sit inside the nested dex list.
export default function TypeBadge(props: { type: string; label: string; color: string }) {
  return <span data-type={props.type} style={{ background: props.color }}>{props.label}</span>
}
