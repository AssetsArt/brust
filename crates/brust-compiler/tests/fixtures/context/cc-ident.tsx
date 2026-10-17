function Item({ children, tone }: { children?: any; tone?: string }) {
  return <span data-tone={tone}>{typeof children === 'function' ? children({ tone }) : children}</span>
}
function fmt(p: any) { return `t:${p.tone}` }
export default function Page() {
  return <main><Item tone="a">{fmt}</Item></main>
}
