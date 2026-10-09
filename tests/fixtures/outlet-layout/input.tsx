import { Outlet } from '@brust/core/routes'
export default function AppLayout(props: { title: string }) {
  return (
    <html lang="en">
      <head><title>{props.title}</title></head>
      <body><nav><a href="/">home</a></nav><main><Outlet /></main></body>
    </html>
  )
}
