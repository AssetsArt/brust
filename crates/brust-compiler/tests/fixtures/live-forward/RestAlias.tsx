// Reads its rest as a value (an alias): the compiler already keeps such a child React (`prop-pattern`), so a live value
// is never bound for it.
export default function RestAlias({ ...rest }: any) {
  const copy = rest
  return <button {...rest}>{copy.label}</button>
}
