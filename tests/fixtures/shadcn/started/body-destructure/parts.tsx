// the props pattern written in the body, as radix-ui's Separator and AspectRatio do
export function Separator(props: any) {
  const { decorative, orientation: orientationProp = 'horizontal', ...domProps } = props
  const orientation = orientationProp === 'vertical' ? 'vertical' : 'horizontal'
  return <div data-orientation={orientation} role={decorative ? 'none' : 'separator'} {...domProps} />
}

export function AspectRatio(props: any) {
  const { ratio = 1, style, ...rest } = props
  return (
    <div style={{ position: 'relative', width: '100%', paddingBottom: `${100 / ratio}%` }} data-wrapper="">
      <div {...rest} style={{ ...style, position: 'absolute', top: 0 }} />
    </div>
  )
}
