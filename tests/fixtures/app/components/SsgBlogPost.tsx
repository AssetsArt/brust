export default function SsgBlogPost({
  params,
  data,
}: {
  params: { slug: string }
  data: { title: string }
}) {
  return (
    <>
      <h1>SsgBlogPost</h1>
      <p data-testid="ssg-slug">{params.slug}</p>
      <p data-testid="ssg-title">{data.title}</p>
    </>
  )
}
