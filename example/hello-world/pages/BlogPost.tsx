import Layout from '../components/Layout'
import type { RouteContext } from '../../../runtime/routes.ts'

interface BlogPostData {
  title: string
}

export default function BlogPost({ params, data }: RouteContext<{ slug: string }, BlogPostData>) {
  return (
    <Layout title={data.title}>
      <h1>BlogPost: {data.title}</h1>
      <p>
        Dynamic route param: <code>slug={params.slug}</code>. Try changing
        the URL — e.g. <a href="/blog/streaming">/blog/streaming</a>.
      </p>
      <p>
        The title above came from an async <code>loader</code> declared in
        <code> routes.tsx</code>; the component received it as the
        <code> data</code> prop. Loaders are the right place for data that
        must resolve <em>before</em> the shell ships.
      </p>
    </Layout>
  )
}
