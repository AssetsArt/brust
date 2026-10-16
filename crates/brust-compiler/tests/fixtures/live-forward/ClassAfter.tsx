// A static child with its own `className` AFTER the spread: its own value wins, the call site's never lands.
export default function ClassAfter({ ...rest }: any) {
  return <button type="button" {...rest} className="own" />
}
