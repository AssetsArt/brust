import type { ErrorBoundaryProps } from '../../../runtime/routes.ts'

export default function CrashBoundary({ error }: ErrorBoundaryProps) {
  return (
    <>
      <h1>CrashBoundary</h1>
      <p>{`caught: ${error.message}`}</p>
    </>
  )
}
