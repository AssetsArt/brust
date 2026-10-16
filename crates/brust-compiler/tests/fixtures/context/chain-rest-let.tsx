function Impl({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  return <div {...rest}>{children}</div>
}
function Switch(props: { type: string; children?: React.ReactNode }) {
  const { type, ...toggleProps } = props
  if (type === 'single') {
    let alias = toggleProps
    return <Impl {...alias} />
  }
  return <i />
}
export default function Page() {
  return <Switch type="single">x</Switch>
}
