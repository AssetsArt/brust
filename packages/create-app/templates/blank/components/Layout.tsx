// The document root: a plain <html> with <Outlet/> for the page. app.css (Tailwind CSS v4) is imported here; brust
// builds it into one hashed file and links it in <head>. Static files are served from /public.
import { Outlet } from '@brust/core/routes'
import '../app.css'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>brust app</title>
        <link rel="icon" href="/public/favicon.svg" />
      </head>
      <body className="bg-paper font-sans text-ink leading-[1.55]">
        <main className="mx-auto box-border max-w-2xl px-4 py-16">
          <Outlet />
        </main>
      </body>
    </html>
  )
}
