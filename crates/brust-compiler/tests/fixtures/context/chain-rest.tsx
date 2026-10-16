const NAME = 'ToggleGroup'
const Kinds = { Single: 'single', Multiple: 'multiple' } as const

function Impl({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) {
  return <div {...rest}>{children}</div>
}
function Switch(props: { type: string; children?: React.ReactNode; label?: string }) {
  const { type, ...toggleProps } = props
  if (type === Kinds.Single) {
    const singleProps = toggleProps
    return <Impl role="radiogroup" {...singleProps} />
  }
  if (type === Kinds.Multiple) {
    const multipleProps = toggleProps
    return <Impl role="toolbar" {...multipleProps} />
  }
  throw new Error(`Missing prop \`type\` expected on \`${NAME}\``)
}
export default function Page() {
  return (
    <main>
      <Switch type="single" label="s">
        one
      </Switch>
      <Switch type="multiple" label="m">
        two
      </Switch>
    </main>
  )
}
