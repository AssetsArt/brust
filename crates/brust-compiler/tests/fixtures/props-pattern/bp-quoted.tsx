export default function C(props: any) {
  const { 'data-x': dx, ...rest } = props
  return <div data-y={dx} {...rest} />
}
