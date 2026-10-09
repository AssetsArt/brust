import { useState } from 'react'
export default function Layout(props: { title: string; lang: string }) {
  const [open, setOpen] = useState(false)
  return (
    <html lang={props.lang}>
      <head>
        <meta charSet="utf-8" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/public/app.css" />
      </head>
      <body data-open={open ? 'yes' : 'no'}>
        <header><button onClick={() => setOpen(!open)}>menu</button></header>
        <main id="content">{props.title}</main>
      </body>
    </html>
  )
}
