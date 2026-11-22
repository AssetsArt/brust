import Parent from './Parent'

export default function Page(props: { show?: boolean; items?: { type: string; id: string }[] }) {
  if (props.show === true && props.items) return <Parent items={props.items} />
  return <main />
}
