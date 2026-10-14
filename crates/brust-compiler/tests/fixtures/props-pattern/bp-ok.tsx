export default function C(props: any) {
  const { a = 'x', n: renamed = 2 } = props
  return <div>{a}{renamed}</div>
}
