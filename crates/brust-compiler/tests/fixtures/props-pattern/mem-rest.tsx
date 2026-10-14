export default function C({ title, ...rest }: any) {
  return <p>{title}{rest.loop}</p>
}
