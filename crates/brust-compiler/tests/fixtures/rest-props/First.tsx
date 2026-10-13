// The spread first: an attribute written after it wins.
export default function First({ ...props }: any) {
  return <span {...props} role="note" />
}
