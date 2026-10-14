// Reads its rest as a value (every key counts as read).
export default function RestRead({ ...rest }: any) {
  return <button {...rest}>{Object.keys(rest).length}</button>
}
