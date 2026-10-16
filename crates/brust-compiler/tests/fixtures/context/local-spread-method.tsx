function Impl({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  return <button {...rest}>{children}</button>
}
function Item(props: { value: string; children?: React.ReactNode }) {
  const bad = { ...props, onClick() {} }
  return <Impl {...bad} />
}
export default function Page() {
  return <Item value="a">x</Item>
}
