import type { ErrorBoundaryProps } from '../../../runtime/routes.ts'

export default function AdminErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <section data-testid="AdminErrorBoundary">
      <h1>Admin error</h1>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </section>
  )
}
