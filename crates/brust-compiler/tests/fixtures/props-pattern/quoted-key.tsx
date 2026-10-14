export default function C({ 'data-x': dx, ...rest }: { 'data-x'?: string }) {
  return <div data-y={dx} {...rest} />
}
