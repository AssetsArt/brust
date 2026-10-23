function Impl({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  return <div {...rest}>{children}</div>
}
function Group(props: { dir?: string; children?: React.ReactNode; [k: string]: unknown }) {
  const { dir, ...groupProps } = props
  const commonProps = { role: 'group', dir: dir, ...groupProps }
  console.log(commonProps)
  return <Impl {...commonProps} data-x="1" />
}
export default function Page() {
  return <Group dir="ltr">one</Group>
}
