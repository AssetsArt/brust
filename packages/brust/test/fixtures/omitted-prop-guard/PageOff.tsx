import ParentOff from './ParentOff'

export default function PageOff(props: { show?: boolean; items?: { id: string }[] }) {
  if (props.show === true && props.items) return <ParentOff items={props.items} />
  return <main />
}
