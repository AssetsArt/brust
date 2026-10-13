// Spreads the props and also reads `onClick` by name.
export default function Reads(props: any) {
  return <button {...props}>{props.onClick ? 'on' : 'off'}</button>
}
