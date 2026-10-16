// A static child with its own `style` AFTER the spread: its own value wins, the call site's never lands.
export default function StyleAfter({ ...rest }: any) {
  return <button type="button" {...rest} style={{ color: 'red' }} />
}
