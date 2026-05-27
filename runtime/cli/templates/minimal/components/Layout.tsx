import type { ReactNode } from 'react'

export default function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body className="bg-white text-gray-900 font-sans">
        <main className="max-w-3xl mx-auto px-5 py-8">{children}</main>
      </body>
    </html>
  )
}
