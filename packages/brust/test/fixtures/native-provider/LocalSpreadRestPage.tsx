function Impl({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  return <div {...rest}>{children}</div>
}
function Group(props: { disabled?: boolean; dir?: string; children?: React.ReactNode; [k: string]: unknown }) {
  const { disabled = false, dir, ...groupProps } = props
  const commonProps = { role: 'group', dir: dir, ...groupProps }
  return <Impl {...commonProps} data-d={disabled ? 'y' : 'n'} />
}
export default function LocalSpreadRestPage() {
  return (
    <main>
      <Group dir="ltr" title="t">
        one
      </Group>
    </main>
  )
}
