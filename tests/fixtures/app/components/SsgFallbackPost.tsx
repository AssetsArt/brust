export const clientLoader = async ({ params }: { params: Record<string, string> }) => {
  const resp = await fetch(`/api/ssg-fallback-data/${params.slug}`)
  if (!resp.ok) throw new Error(`data: ${resp.status}`)
  return (await resp.json()) as { title: string }
}

export default function SsgFallbackPost({
  params,
  data,
}: {
  params: { slug: string }
  // Optional: the same component renders server-side (loader data) and via
  // the client takeover (clientLoader data) — and must not crash if either
  // path ever hands it nothing.
  data?: { title: string }
}) {
  return (
    <>
      <h1>SsgFallbackPost</h1>
      <p data-testid="fb-slug">{params.slug}</p>
      <p data-testid="fb-title">{data?.title}</p>
    </>
  )
}
