export default function Card({ 'data-x': dx, ...rest }: any) {
  return <div data-y={dx} {...rest} />
}
