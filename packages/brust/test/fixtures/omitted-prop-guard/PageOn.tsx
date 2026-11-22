import ParentOn from './ParentOn'

export default function PageOn(props: { show?: boolean; items?: { id: string }[] }) {
  if (props.show === true && props.items) return <ParentOn items={props.items} />
  return <main />
}
