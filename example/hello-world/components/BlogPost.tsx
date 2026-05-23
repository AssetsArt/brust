import type { RouteContext } from '../../../runtime/routes.ts'

export default function BlogPost({ params }: RouteContext<{ slug: string }>) {
  return (
    <>
      <h1>BlogPost</h1>
      <p>{`slug=${params.slug}`}</p>
    </>
  )
}
