import type { RouteContext } from '../../../runtime/routes.ts'

interface BlogPostData {
  title: string
}

export default function BlogPost({ params, data }: RouteContext<{ slug: string }, BlogPostData>) {
  return (
    <>
      <h1>BlogPost</h1>
      <p>{`slug=${params.slug}`}</p>
      <p>{data.title}</p>
    </>
  )
}
