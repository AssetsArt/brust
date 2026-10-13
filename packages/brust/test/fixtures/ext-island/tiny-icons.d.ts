// Types of the fixture package (`pkg/`), which tests install into node_modules at run time.
declare module 'tiny-icons' {
  export function Heart(props: { size?: number; title?: string }): React.JSX.Element
  export default Heart
}
