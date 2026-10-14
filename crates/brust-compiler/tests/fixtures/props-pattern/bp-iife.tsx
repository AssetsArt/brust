export default function C(props: any) {
  const { a = (() => '<i>')(), b = 1 } = props
  return <div>{a}{b}</div>
}
