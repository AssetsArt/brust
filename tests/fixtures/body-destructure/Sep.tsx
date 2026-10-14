// the props pattern written in the body, as radix's Separator does
export default function Sep(props: { decorative?: boolean; orientation?: string; [k: string]: unknown }) {
  const { decorative, orientation = 'horizontal', ...domProps } = props
  return <div data-orientation={orientation} role={decorative ? 'none' : 'separator'} {...domProps} />
}
