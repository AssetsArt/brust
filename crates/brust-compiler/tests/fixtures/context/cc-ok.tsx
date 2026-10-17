function Item({ children, tone }: { children?: any; tone?: string }) {
  return <span data-tone={tone}>{typeof children === 'function' ? children({ tone }) : children}</span>
}
export default function Page() {
  return (
    <main>
      <Item tone="a">
        <b>hello</b>
      </Item>
    </main>
  )
}
