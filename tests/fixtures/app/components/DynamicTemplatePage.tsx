import type { RouteContext } from '../../../../runtime/routes.ts'

// R1 dynamic template registry E2E host page. The loader (routes.tsx)
// registers a runtime jinja template and renders it to an HTML string; this
// page inlines that string so the integration test can assert the HTTP body.
export default function DynamicTemplatePage({
  data,
}: RouteContext<Record<string, string>, { html: string }>) {
  return (
    <main>
      <h1>DynamicTemplatePage</h1>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: test fixture renders trusted template output */}
      <div data-testid="dyn-slot" dangerouslySetInnerHTML={{ __html: data.html }} />
    </main>
  )
}
