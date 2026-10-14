export default function C(props: any) {
  const x = a + 1
  const { a = 1 } = props
  return <div>{x}</div>
}
