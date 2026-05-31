export default function NativeLayout({ title, children }: { title: string; children: any }) {
  return (
    <div>
      <header>
        <h1>{title}</h1>
      </header>
      <main>{children}</main>
    </div>
  )
}
