import type { ReactNode } from 'react'

export default function Doc({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <html>
      <head>
        <title>{title}</title>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
