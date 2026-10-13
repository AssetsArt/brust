// A named prop the element binds (`data-open`), the rest spread after it.
export default function Pill({ open, ...props }: any) {
  return <span data-open={open} {...props} />
}
