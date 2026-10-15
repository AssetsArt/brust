// A link whose rest lands on its anchor: a live href would print by the child's tag, which the parent cannot see.
export default function Anchor({ ...rest }: any) {
  return <a {...rest} />
}
