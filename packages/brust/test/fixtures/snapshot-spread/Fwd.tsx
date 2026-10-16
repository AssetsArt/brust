// A forwarding primitive (Radix's Primitive.input shape): every prop reaches the element through a spread.
export default function Fwd(props: any) {
  return <input type="checkbox" {...props} />
}
