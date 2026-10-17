function Item({ children, tone }: { children?: any; tone?: string }) {
  return <span data-tone={tone}>{typeof children === 'function' ? children({ tone }) : children}</span>
}
export default function Page() {
  return <main><Item tone="a">{(p: any) => <b>{p.tone}</b>}</Item></main>
}
