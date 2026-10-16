// F277: a live style object reaches this static child's element through `{...style}`: it binds as an object style.
export default function Sized({ style, ...props }: { style?: { width?: number }; name?: string }) {
  return <input type="checkbox" data-testid="sized" {...props} tabIndex={-1} style={{ ...style, position: 'relative', opacity: 0.5 }} />
}
