// A static forwarder: everything reaches the element through a spread.
export default function Fwd(props: any) {
  return <i {...props} />
}
