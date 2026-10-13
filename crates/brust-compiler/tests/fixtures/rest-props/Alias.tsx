// Written after the spread: the React names win over the call site's HTML aliases.
export default function Alias({ ...props }: any) {
  return <label {...props} className="x" htmlFor="a" />
}
