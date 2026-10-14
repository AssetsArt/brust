// two patterns over props: the rest of the second leaves out only the keys of ITS pattern (as in JS, `a` stays in it)
export default function Two(props: any) {
  const { a } = props
  const { b, ...rest } = props
  return <p {...rest}>{a}{b}</p>
}
