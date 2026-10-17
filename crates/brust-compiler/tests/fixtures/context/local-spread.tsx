function Impl({ pressed, disabled, children, ...rest }: { pressed?: boolean; disabled?: boolean; children?: React.ReactNode; [k: string]: unknown }) {
  return (
    <button type="button" aria-pressed={pressed} disabled={disabled} {...rest}>
      {children}
    </button>
  )
}
function Item(props: { value: string; title?: string; disabled?: boolean; children?: React.ReactNode }) {
  const pressed = props.value === 'a'
  const disabled = props.disabled
  const commonProps = { ...props, pressed, disabled }
  return <Impl {...commonProps} />
}
export default function Page() {
  return (
    <main>
      <Item value="a" title="first">
        one
      </Item>
      <Item value="b" disabled>
        two
      </Item>
    </main>
  )
}
